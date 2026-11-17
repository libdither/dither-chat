# Sensitive messages

Messages you would not want on a screen someone else can see (health, money trouble, grief, anything private) can be
covered or hidden, a little or a lot, by how sure the local model is. Settings → Sensitive messages turns it on. It is
off by default.

## How it decides

The hub asks the machine's local yes/no model (jev, the same one alerts use: [deploy.md](deploy.md#categories-and-local-models))
one question about every new message, yours too:

> Is this message sensitive, something to keep off a screen others can see: about health, sex, violence, money
> trouble, grief, or anything private or upsetting?

The model reads the text only, with `[picture]`, `[video]`, `[voice message]` or `[file]` for each attachment; it never
sees the pictures. Its answer, P(yes), is kept per message and per version of the question (`sensitive_score`).
Nothing leaves the machine.

Two lines on that chance, both set in Settings:

| chance             | what the chat does                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------- |
| below **Cover**    | shows it                                                                                    |
| **Cover** to Hide  | covers its words and files: **blurred**, or **black bars** the length of the words          |
| **Hide** and above | **one line in its place** ("Sensitive message hidden · Show"), or **gone**, with a count at the top of the chat |

A covered message has a Show button; what you uncover stays uncovered until the page reloads. A covered or hidden
message is in no run of pictures ([pictures.md](pictures.md)): its pictures stay under its own cover.

## Your answers, and a better question

Each covered or hidden message asks "Sensitive? Yes / No, fine", and so does one you uncovered. From any message's
menu, **Sensitive…** says the same about a message the model let through. Your answer wins over the model for that
message, and is kept on the hub (`sensitive_vote`) with the chance it was shown with.

The answers score the question. Settings → Sensitive messages shows, for the question in use:

- the counts at the Cover line: model covers or hides / shows, against you said sensitive / fine;
- agreement (the share where the line and you agree) and average precision (how well its chances order your answers,
  with no line at all);
- the Cover line that would agree with you most.

To change the question, edit it and **Try on my answers**: the hub asks the new question about every message you
answered on (only those), and shows its scores beside the one in use. It is not used until you press **Use**. Then new
messages, and the last 2,000, are asked the new question in the background; until a message has been, it keeps its
chance from the question before. Every question tried is kept, with the one in use marked, so you can go back.

`GET /api/sensitive/disagreements?v=` lists the messages a question and your answers part on, furthest first: what to
read before writing the next question.

## API

| route                                     | what                                                     |
| ----------------------------------------- | -------------------------------------------------------- |
| `GET /api/sensitive`                      | settings, questions, agreement, model, waiting count     |
| `PATCH /api/sensitive/settings`           | `{ on?, cover?, hide?, style?: blur\|bar, top?: line\|gone }` |
| `POST /api/sensitive/prompts`             | `{ question }`: tried on your answers, not put in use    |
| `POST /api/sensitive/prompts/:v/adopt`    | put a question in use                                    |
| `GET /api/sensitive/disagreements?v=`     | where it and you part, with the messages                 |
| `POST /api/messages/:id/sensitive`        | `{ vote: true \| false \| null }`                         |

Each `MessageView` carries `sensitive: { p, v, vote? }` once it has a chance or an answer.

## Models

`DITHER_SENSITIVE_MODEL` picks what judges: `jev` (the default, at `DITHER_JEV_URL`), `keyword` (a demo hub's: a few
words), or `off` (only your answers cover anything). When jev fails the hub waits a minute and asks again; messages
not yet judged are shown.

## Not done yet

- The settings are read when a chat first opens: a change on another device shows after a reload.
- The inbox row's preview and notifications still show a sensitive message's text.
- No picture model: a picture with no words is judged by its `[picture]` alone.
