"""Cryptographically selected phrases; no transcript is passed as STT keyterms."""

import re
import secrets
import unicodedata
from importlib.resources import files


def wordlist() -> tuple[str, ...]:
    words = tuple(files("hearsay").joinpath("words.txt").read_text().split())
    if len(words) != 300 or len(set(words)) != 300 or not all(w.isalpha() for w in words):
        raise ValueError("phrase wordlist must contain 300 unique alphabetic words")
    return words


def new_phrase() -> str:
    return " ".join(secrets.SystemRandom().sample(wordlist(), 5))


def normalize_words(text: str) -> list[str]:
    return re.findall(r"[a-z]+", unicodedata.normalize("NFKC", text).casefold())


def phrase_match(phrase: str, transcript: str) -> tuple[bool, float]:
    """Best contiguous five-word transcript window; punctuation/case ignored.

    Levenshtein alignment tolerates one missing/substituted word. Windows of four
    words also handle an omitted word without requiring bystander speech.
    """
    expected, spoken = normalize_words(phrase), normalize_words(transcript)
    if len(expected) != 5:
        raise ValueError("expected a five-word challenge")

    def distance(a, b):
        row = list(range(len(b) + 1))
        for i, word in enumerate(a, 1):
            following = [i]
            for j, other in enumerate(b, 1):
                following.append(min(row[j] + 1, following[-1] + 1, row[j - 1] + (word != other)))
            row = following
        return row[-1]

    windows = [
        spoken[i : i + size] for size in (4, 5) for i in range(max(0, len(spoken) - size + 1))
    ]
    errors = min((distance(expected, part) for part in windows), default=5)
    return errors <= 1, errors / 5
