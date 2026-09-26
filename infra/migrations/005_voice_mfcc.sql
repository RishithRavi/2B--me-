-- 005 (additive, post-CP0): voice profile MFCC mean so spec_sim = cosine([LTAS(64) ‖ MFCC-mean(20)], profile)
-- spectral_summary stays the 64-bin mel LTAS (dB) shown next to the reply spectrogram.
ALTER TABLE voice_profiles ADD COLUMN IF NOT EXISTS mfcc_mean vector(20);
