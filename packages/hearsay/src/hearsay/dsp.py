"""Deterministic DSP summaries; no learned thresholds or authenticity claims."""

import numpy as np

from .audio import SAMPLE_RATE, mono_16k

N_FFT = 512
HOP = 160
MELS = 64


def _frames(x: np.ndarray, width: int) -> np.ndarray:
    padded = np.pad(x, (0, max(0, width - len(x))))
    return np.lib.stride_tricks.sliding_window_view(padded, width)[::HOP]


def _mel_bank() -> tuple[np.ndarray, np.ndarray]:
    mel_max = 2595 * np.log10(1 + 7200 / 700)
    hz = 700 * (10 ** (np.linspace(0, mel_max, MELS + 2) / 2595) - 1)
    frequencies = np.fft.rfftfreq(N_FFT, 1 / SAMPLE_RATE)
    up = (frequencies[None, :] - hz[:-2, None]) / (hz[1:-1] - hz[:-2])[:, None]
    down = (hz[2:, None] - frequencies[None, :]) / (hz[2:] - hz[1:-1])[:, None]
    bank = np.maximum(0, np.minimum(up, down))
    bank /= np.maximum(bank.sum(axis=1, keepdims=True), 1e-12)
    return bank, hz[1:-1]


def _f0(x: np.ndarray) -> float:
    """Autocorrelation estimate, 60–400 Hz; zero denotes no voiced estimate."""
    frames = _frames(x, 1024).astype(np.float64)
    frames -= frames.mean(axis=1, keepdims=True)
    energy = np.mean(frames**2, axis=1)
    active = frames[energy > max(1e-10, float(energy.max()) * 0.01)]
    estimates = []
    low, high = SAMPLE_RATE // 400, SAMPLE_RATE // 60
    for frame in active:
        spectrum = np.fft.rfft(frame, 2048)
        acf = np.fft.irfft(abs(spectrum) ** 2, 2048)[:1024]
        acf /= max(acf[0], 1e-12)
        peaks = [
            lag for lag in range(low, high) if acf[lag] >= acf[lag - 1] and acf[lag] > acf[lag + 1]
        ]
        if not peaks:
            continue
        best = max(peaks, key=lambda lag: acf[lag])
        if acf[best] >= 0.6:
            estimates.append(SAMPLE_RATE / best)
    return float(np.median(estimates)) if estimates else 0.0


def analyze(samples: np.ndarray, sample_rate: int = SAMPLE_RATE) -> dict:
    """Internal analysis with LTAS(64), MFCC(20) and a 64×128 spectrogram.

    Keep LTAS and MFCC separate until the shared enrollment profile dimension is
    frozen. Silence remains finite and contributes no pitch or spectral energy.
    """
    x = mono_16k(samples, sample_rate)
    frames = _frames(x, N_FFT).astype(np.float64)
    power = abs(np.fft.rfft(frames * np.hanning(N_FFT), axis=1)) ** 2 / N_FFT
    frequencies = np.fft.rfftfreq(N_FFT, 1 / SAMPLE_RATE)
    valid = frequencies <= 7200
    spectrum = power[:, valid]
    freq = frequencies[valid]
    totals = spectrum.sum(axis=1)
    active = totals > 1e-12
    divisor = np.maximum(totals, 1e-12)
    centroid = (spectrum * freq).sum(axis=1) / divisor
    roll_idx = np.argmax(np.cumsum(spectrum, axis=1) >= 0.85 * totals[:, None], axis=1)
    rolloff = np.where(active, freq[roll_idx], 0)
    flatness = np.where(
        active,
        np.exp(np.mean(np.log(np.maximum(spectrum, 1e-12)), axis=1))
        / np.maximum(spectrum.mean(axis=1), 1e-12),
        0,
    )
    hf = spectrum[:, freq > 4000].sum() / max(float(totals.sum()), 1e-12)
    bank, mel_hz = _mel_bank()
    mel_power = bank @ power.T
    mel_db = 10 * np.log10(np.maximum(mel_power, 1e-12))
    ltas = 10 * np.log10(np.maximum(mel_power.mean(axis=1), 1e-12))
    dct = np.cos(np.pi / MELS * np.arange(20)[:, None] * (np.arange(MELS) + 0.5))
    dct *= np.sqrt(2 / MELS)
    dct[0] /= np.sqrt(2)
    mfcc = dct @ mel_db
    times = (np.arange(power.shape[0]) * HOP + N_FFT / 2) / SAMPLE_RATE
    target_times = np.linspace(times[0], times[-1], 128)
    image = np.stack([np.interp(target_times, times, band) for band in mel_db])
    stats = {
        "spectral_centroid_hz": float(centroid.mean()),
        "spectral_rolloff_hz": float(rolloff.mean()),
        "spectral_flatness": float(flatness.mean()),
        "hf_energy_ratio": float(hf),
        "f0_median_hz": _f0(x),
        "rms": float(np.sqrt(np.mean(x.astype(float) ** 2))),
    }
    return {
        "dsp": stats,
        "ltas_db": ltas.tolist(),
        "mfcc_mean": mfcc.mean(axis=1).tolist(),
        "mfcc_std": mfcc.std(axis=1).tolist(),
        "spectrogram": {
            "f_hz": mel_hz.tolist(),
            "t_s": target_times.tolist(),
            "db": image.tolist(),
        },
    }


def spectral_similarity(current, enrolled) -> float:
    current, enrolled = np.asarray(current, dtype=float), np.asarray(enrolled, dtype=float)
    if (
        current.ndim != 1
        or current.shape != enrolled.shape
        or current.size not in (64, 83, 84)
        or not np.isfinite(current).all()
        or not np.isfinite(enrolled).all()
    ):
        raise ValueError("spectral vectors must have matching 64, 83 or 84 finite dimensions")
    norm = np.linalg.norm(current) * np.linalg.norm(enrolled)
    if norm <= 1e-12:
        raise ValueError("cannot compare a zero spectral vector")
    return float(np.clip(current @ enrolled / norm, -1, 1))


def spectral_vector(ltas_db, mfcc_mean) -> np.ndarray:
    """Return the calibrated 83-d identity vector.

    Absolute energy and MFCC c0 mostly describe recording level. Removing them
    keeps the comparison focused on spectral shape, as required by the voice
    runbook. Stored profiles retain the raw 64+20 values for compatibility.
    """
    ltas = np.asarray(ltas_db, dtype=np.float64)
    mfcc = np.asarray(mfcc_mean, dtype=np.float64)
    if (
        ltas.shape != (64,)
        or mfcc.shape != (20,)
        or not np.isfinite(ltas).all()
        or not np.isfinite(mfcc).all()
    ):
        raise ValueError("spectral profile requires 64 LTAS and 20 finite MFCC values")
    return np.concatenate([ltas - ltas.mean(), mfcc[1:]])


def findings(current: dict, enrolled: dict) -> list[str]:
    """Describe measurements only; thresholds/decisions belong to calibration."""
    before, after = enrolled["hf_energy_ratio"], current["hf_energy_ratio"]
    if min(before, after) <= 1e-12:
        return ["High-frequency comparison unavailable: insufficient spectral energy."]
    change = 10 * np.log10(after / before)
    return [f"Energy above 4 kHz (7.2 kHz guard) {change:+.1f} dB vs your profile."]
