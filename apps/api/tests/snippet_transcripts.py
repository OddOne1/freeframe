"""Realistic transcript fixtures for clip detection (tests/test_snippet_detect.py).

Written by hand to look like what Whisper leaves in `transcript_words` for
a two-microphone interview: track 0 is the guest, track 1 the host, each
word a dict with millisecond times. The English one opens with the retakes
and production chatter of the 57-minute interview that "tfidf-v1" turned
into clips ("Fuck · Go · Good"); both languages then have a real answer
worth clipping, a filler-heavy one, a quick back-and-forth, a run of
unanswered questions and a profane but good story.

Timing is a steady 380 ms a word (about 2.6 words a second, ordinary
interview pace), with a short breath after each sentence, a longer pause
at a blank line (the speaker finished a thought) and a pause at each
change of speaker.
"""

WORD_MS = 300
GAP_MS = 80
SENTENCE_PAUSE_MS = 300
PARAGRAPH_PAUSE_MS = 1_000
TURN_PAUSE_MS = 800

GUEST, HOST = 0, 1

#: Third element of a turn: said OVER the next turn, not after it.
OVER = "over"


def conversation(turns, *, start_ms=0):
    """(words_by_track, end_ms) for a list of (track, text[, OVER]) turns.

    A blank line inside a text is a pause of PARAGRAPH_PAUSE_MS, the end of
    one thought; turns follow each other with TURN_PAUSE_MS between. A turn
    marked OVER is an interjection: its words start where they are, but the
    clock does not move for them, so the next turn runs on underneath with
    no pause -- the other speaker said it while the first kept talking.
    """
    by_track: dict = {}
    t = start_ms
    overlapping = False
    for index, turn in enumerate(turns):
        track, text = turn[0], turn[1]
        over = len(turn) > 2 and turn[2] == OVER
        if index and not overlapping:
            t += TURN_PAUSE_MS
        resume_at = t
        for p_index, paragraph in enumerate(text.strip().split("\n\n")):
            if p_index:
                t += PARAGRAPH_PAUSE_MS
            for token in paragraph.split():
                by_track.setdefault(track, []).append(
                    {"start_ms": t, "end_ms": t + WORD_MS, "word": " " + token}
                )
                t += WORD_MS + GAP_MS
                if token.rstrip("\"')").endswith((".", "!", "?")):
                    t += SENTENCE_PAUSE_MS
        if over:
            t = resume_at
        overlapping = over
    for words in by_track.values():
        words.sort(key=lambda w: (w["start_ms"], w["end_ms"]))
    end_ms = max(w["end_ms"] for words in by_track.values() for w in words)
    return by_track, max(t, end_ms)


def media_file(turns, *, media_file_id="mf-1", duration_ms=None, speakers=None):
    """The dict detect_snippets takes, from (track, text) turns."""
    by_track, end_ms = conversation(turns)
    speakers = speakers or {GUEST: ("Anna Example", "sp-guest"), HOST: ("Host", "sp-host")}
    return {
        "media_file_id": media_file_id,
        "duration_ms": duration_ms if duration_ms is not None else end_ms,
        "tracks": {
            track: {"speaker": speakers.get(track, (None, None))[0],
                    "speaker_id": speakers.get(track, (None, None))[1],
                    "words": words}
            for track, words in by_track.items()
        },
    }


# ── English: a baker, with the retakes first ─────────────────────────────

EN_RETAKES = [
    (HOST, "Okay, go again."),
    (GUEST, "Fuck me, there's some people here ready. Okay. Sorry, can we start "
            "again? Is it recording? Okay, go again. Yeah. Good, good. Okay. "
            "We've got a moment, go. Sorry. Good, good, go."),
    (HOST, "Yeah, we're rolling. Take two. Go."),
    (GUEST, "Okay. Yeah. Sorry, is the mic on? Check, check. Okay, go again. "
            "Good. Okay, good, really good, go."),
]

#: The answer a person would clip: a first-person story, past tense,
#: numbers, a place, a strong claim.
EN_STORY = (
    "My grandmother opened the first shop in Vienna in 1962 with one oven and "
    "a loan she never told my grandfather about. She baked four hundred rolls "
    "every morning before sunrise, and she sold out by nine. When I was eleven "
    "I started folding croissants on Saturdays, and I burned my first batch so "
    "badly that the whole street smelled of it. She laughed and made me fold "
    "them again until my hands remembered."
)

#: Opinion and specifics: the second clip.
EN_OPINION = (
    "The biggest mistake we made was growing too fast. In 2015 we opened three "
    "new stores in eighteen months, and the quality dropped everywhere at "
    "once. Our regular customers noticed before we did. I honestly believe a "
    "bakery can only be as big as the number of people who still care about "
    "the dough."
)

#: Starts cleanly, then searches for words: fillers and restarts.
EN_FILLER = (
    "It's hard to say, um, you know, it's, it's kind of, um, a lot of things. "
    "I mean, I don't know, it was, um, sort of the timing, I guess, you know? "
    "We, we, we just, um, you know, kind of did stuff and, um, and stuff. "
    "It's, um, I mean, it's hard, you know, it's, it's just hard."
)

#: Swears, and is still the best story in the file.
EN_PROFANE_STORY = (
    "The worst day was the flood in 2019. The cellar filled with water "
    "overnight and we lost every bag of flour we had, about two tonnes of it. "
    "I stood there at five in the morning thinking, this is fucking it, we "
    "are done. Then forty neighbours turned up with buckets, and by noon the "
    "shop was open again. I will never forget that."
)

EN_INTERVIEW = EN_RETAKES + [
    (HOST, "So tell me how the bakery started."),
    (GUEST, EN_STORY),
    (HOST, "Mhm."),
    (GUEST, EN_OPINION),
    (HOST, "What would you do differently?"),
    (GUEST, EN_FILLER),
    # Quick back-and-forth: the host keeps cutting in with short questions
    # while the guest answers in fragments.
    (HOST, "Is it the dough?"),
    (GUEST, "Partly the dough, the dough decides a lot of it."),
    (HOST, "The ovens?", OVER),
    (GUEST, "Not the ovens, honestly, they are thirty years old."),
    (HOST, "And the people?", OVER),
    (GUEST, "The people, always the people first, every time."),
    (HOST, "The rent?", OVER),
    (GUEST, "The rent is what keeps me awake at night."),
    (HOST, "Every month?", OVER),
    (GUEST, "Every single month, without fail, it does."),
    # The host asking, at length, and nobody answering in the window.
    (HOST, "What does a good croissant need, in the end? Is it the butter from "
           "the mountains? Is it the time you give the dough overnight? Is it the "
           "flour, or the temperature of the room in winter? Or is it just "
           "patience that nobody can teach? What would your grandmother say?"),
    (GUEST, "Patience."),
    (HOST, "What was the worst day?"),
    (GUEST, EN_PROFANE_STORY),
    # Trails off: no clip may end here.
    (GUEST, "And after that we kind of, we tried the new"),
]


# ── German: a winemaker ──────────────────────────────────────────────────

DE_RETAKES = [
    (HOST, "Okay, nochmal."),
    (GUEST, "Läuft die Kamera? Sorry, können wir von vorne anfangen? Ja. Gut. "
            "Okay. Noch mal, sorry. Gut, gut. Ist das Mikro an? Okay, nochmal von "
            "vorne. Ja, gut, okay."),
]

DE_STORY = (
    "Mein Vater hat den Weinberg 1987 gekauft, ohne jemals Wein gemacht zu "
    "haben. Im ersten Jahr hat der Hagel fast alles zerstört, und er hat "
    "trotzdem weitergemacht. Ich war damals sieben und bin jeden Morgen mit "
    "ihm durch die Reihen gegangen. Er hat mir gezeigt, wie man an den "
    "Blättern erkennt, ob die Rebe Durst hat."
)

DE_OPINION = (
    "Der größte Fehler in unserer Branche ist, dass alle nur noch auf Punkte "
    "schauen. Ein Wein mit 95 Punkten ist nicht automatisch ein guter Wein. "
    "Ich glaube, die Wahrheit steht im Glas und nicht auf dem Etikett. Wir "
    "verkaufen heute dreißig Prozent direkt ab Hof, und diese Kunden sagen "
    "uns ehrlich, was sie denken."
)

DE_FILLER = (
    "Das ist halt, äh, schwer zu sagen, weißt du, das ist, das ist irgendwie, "
    "äh, so eine Sache. Ich mein, äh, quasi, sag ich mal, halt die Zeit und "
    "so, äh, irgendwie. Wir haben, wir haben halt, äh, sozusagen einfach "
    "gemacht, oder so. Das ist halt, äh, irgendwie schwer, weißt du."
)

DE_PROFANE_STORY = (
    "Der Frost im April 2017 war richtig scheiße. In einer einzigen Nacht "
    "sind siebzig Prozent der Knospen erfroren, und wir standen um drei Uhr "
    "früh mit Fackeln zwischen den Reihen. Mein Bruder hat geweint, ich habe "
    "nur noch geflucht. Im Herbst haben wir dann den besten Riesling gemacht, "
    "den wir je hatten, aus einem Viertel der Menge."
)

DE_INTERVIEW = DE_RETAKES + [
    (HOST, "Wie hat das mit dem Weingut angefangen?"),
    (GUEST, DE_STORY),
    (HOST, "Mhm."),
    (GUEST, DE_OPINION),
    (HOST, "Was würdest du anders machen?"),
    (GUEST, DE_FILLER),
    (HOST, "Was war das schlimmste Jahr?"),
    (GUEST, DE_PROFANE_STORY),
]


# ── One speaker, for the database tests ──────────────────────────────────

#: A guest talking on their own: three strong answers with pauses
#: between them, about two minutes. Yields a clip per answer.
EN_MONOLOGUE = [(GUEST, "\n\n".join([EN_STORY, EN_OPINION, EN_PROFANE_STORY]))]
