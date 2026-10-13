# Second check (typed decisions, any model)

Cold can put a short set of typed questions to the model you already use, as an independent second opinion. It follows the idea of
[Jev](https://github.com/nico-martin/open-jev)-style "typed decisions": one shared text, many questions, **one model call**, and every answer is
one of the options Cold offered (or *unanswered*), never free text. Unlike Jev it does **not** read probabilities from a model's logits, because a
generic provider doesn't expose them. What you get is the model's chosen option plus a confidence *word* it states (high, medium, low).

It needs nothing from a model beyond "reply with JSON", so it works the same with the on-device model, a model server on this computer (Ollama),
a hosted model, or the Cold desktop app's model. It is `src/domain/decide.js` (the engine) and `src/domain/jevChecks.js` (the questions).

## What the engine enforces in code, whatever the model says

- An answer outside the offered options is *unanswered* (it is never rounded to the nearest option). "unsure" is allowed and also *unanswered*.
- A question marked grounded needs a quote copied from the text for the answers it names (for example every "yes"); a quote that isn't really in the text drops the answer.
- The text is data: it is fenced, cannot close its own fence, and nothing in it is followed. Words taken from a page never appear outside the fence.
- A reply that can't be used, or a provider error, means "not answered". It never throws into the thing being checked, so a check can fail open to "not checked". Cancelling still cancels.

## Where it is used

1. **Opportunities (Ask Cold, Browse With Me).** After Cold's own evaluator finds something and its own checks keep it, **one** more call asks, for each
   opportunity: does the page support the conclusion, what signal does it show (hiring, funding, launch, expansion, stated problem, leadership change),
   how well does your product fit (none, weak, moderate, strong), what is this organization to you (customer, competitor, partner, supplier, media or analyst),
   and is it current; plus whether the page tries to instruct an AI assistant. The answers appear on the card as "Second check". They can only make Cold
   **more cautious**: lower a confidence (not supported, no fit, a competitor or media, dated) or add a note. They never raise a confidence, add an
   opportunity, or hide one. If nothing was found, no call is made. If the check can't run, the card says the results weren't double-checked.
   Page text goes only where the evaluator's already went (the same model, under the same on-this-computer rule).
2. **A drafted email ("Second check (optional)" in the draft's review area).** On request only: seven questions about the draft against your
   product facts (external-use proof only) and your reason for writing: opens with what you do, reason specific to them, invented facts, manufactured
   commonality, number of proof points, whether the ask matches the goal you chose, plain English. Each row says OK, *worth a look* or *not checked*. A concern
   needs the model to be at least medium-sure and, for "invented fact" or "commonality", a real quote from the draft. It does not change the style
   score, edit the draft or save anything, and it goes stale (and says so) when you edit.

## More questions

Ask Cold keeps its four quick questions and adds five under "More questions": is this company hiring for something my product helps with; did something
change recently (funding, a launch, a new leader); who here would care about my product, and why them; is this a competitor or partner rather than a
customer; which of my products fits this page best. They steer the same evaluator.

## Limits

A second check is another pass by a model that can be wrong in the same ways, and a small on-device model is a weak reviewer. It is a prompt to look,
not a verdict. Accuracy of any real model on these questions has **not** been measured; the automated tests use canned answers
(`test/decide.test.js`, `test/second-check.test.js`, and the Ask Cold test in `test/extension.test.js`) and prove behaviour, not quality.
