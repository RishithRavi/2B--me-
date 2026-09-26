import pytest
from hearsay.phrases import new_phrase, phrase_match, wordlist


def test_phrase_vocabulary_and_no_repeated_words():
    words = wordlist()
    for _ in range(50):
        phrase = new_phrase().split()
        assert len(set(phrase)) == 5
        assert set(phrase) <= set(words)


@pytest.mark.parametrize(
    "text,expected",
    [
        ("LOUD BYSTANDER! ACORN, cactus dolphin garden jacket. more speech", (True, 0)),
        ("acorn cactus garden jacket", (True, 0.2)),
        ("acorn cactus monkey garden jacket", (True, 0.2)),
        ("acorn cactus dolphin", (False, 1)),
        ("jacket garden dolphin cactus acorn", (False, 0.8)),
        ("", (False, 1)),
    ],
)
def test_best_aligned_phrase(text, expected):
    assert phrase_match("acorn cactus dolphin garden jacket", text) == expected
