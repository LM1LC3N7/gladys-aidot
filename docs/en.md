# AiDot

Brings the **AiDot Wi-Fi lights** (Linkind, OREiN and the other brands set up
with the AiDot app) into Gladys: on / off, brightness, colour and colour
temperature, and the changes the lights push (app, switch, schedules) shown at
once.

> Never tested with a real device: tell us on the forum how it goes. Not
> affiliated with AiDot.

## How it works

- **The AiDot cloud, for the list only.** With the e-mail and the password of
  your AiDot account, the integration reads the list of your lights: their
  name, model, address on your network and the local keys each light needs.
  It signs in as python-aidot, the maker's own library (the one Home Assistant
  uses), does: with the **application id of that library**. Louis, who
  maintains these integrations, accepted it for this integration only, on
  2026-11-05. Nothing else imitates an application.
- **Your network, for everything else.** Each light added in Gladys is driven
  directly on your network (TCP port 10000, AES with the key of the light): no
  command goes through the cloud. The address comes from the cloud; when it is
  missing or wrong, a discovery request is broadcast by Gladys itself
  (UDP 6666, as the AiDot app does) to find it.
- The password, the tokens of the session, your user id and the keys of the
  lights are never written to a log, the status or the `/data` folder of the
  integration; the tokens and the keys stay in memory.

## Configuration

1. **E-mail** and **password** of the AiDot account (the ones of the app). The
   password is kept by Gladys in its database, never shown again, and sent
   only to the AiDot cloud when the integration signs in.
2. **Country of the account**: the one chosen when the account was made; it
   picks the AiDot cloud (Europe, America or Asia).
3. **Reading interval**: how often each light is read on the network (60 s by
   default, 30 s at least). The changes the light pushes come at once between
   two reads.
4. Save, then open **Discover**: each light with a local key is listed with its
   name in the AiDot app. Add the ones you want: only the lights added are
   connected.

**Test the connection** signs in to the AiDot cloud with the credentials saved
(even after a refusal, at most every 10 s, never while AiDot asked to wait) and
reads the list of the lights.

## The cloud, politely

- The list is read at start, every 6 hours and on **Discover**, never sooner
  than a minute after the read before (a restart included: the time of each
  attempt is kept in `/data`). New credentials saved and **Test the
  connection** (10 s apart at most) do not wait for that minute.
- **Refused e-mail or password**: only the sign-in can say it. The refusal is
  kept (in `/data`: a fingerprint of the account and a 6-value mark of the
  password, never the password) and **the password is never sent again by
  itself**, a restart included, until you save other credentials or click
  **Test the connection**. Any other error of
  the cloud (a session not accepted, an unreadable answer) is never taken for a
  refusal: the session is renewed, and the read tried again later.
- **AiDot asks to wait** (HTTP 429 or 5xx): the cloud is left alone 60 s,
  doubled up to 6 h (or what AiDot asks, within these bounds), kept across a
  restart. Not reached: new tries after 1, 2, 5, 15, 30 min, then every hour.
- None of this stops the lights already known: they are driven on the network.

## Devices

| AiDot light                         | Features                                          |
| ----------------------------------- | ------------------------------------------------- |
| Every light                         | Power (0 / 1), brightness (0 to 100, 0 = off)     |
| Colour (`control.light.rgbw`)       | + colour, colour temperature (2700-6500 K)        |
| White tunable (`control.light.cct`) | + colour temperature, in the range of the product |

A colour, a temperature or a brightness also turns the light on. A
temperature out of the range of the light, or a colour on a white light, is
refused before anything is sent.

## How commands are sent

- One connection per light, one message at a time on it. A command is done once
  the light shows the new state after it (answered by the light, or changed
  from before); otherwise its message says why ("sent, without confirmation",
  "shows another state", "refused by the light") and the light is read again
  5 s later.
- A scene on many lights sets every light: a command still waiting for its
  connection after 3.5 s says so and still leaves within 30 s; the commands of
  one light waiting are merged.

## Turning off (Off)

An Off (power 0, or brightness 0) needs no option and goes first: it cancels
the commands of that light still waiting (none of them leaves after it), cuts
a request that has had no answer for 1 s, and goes whatever the cloud says (a
refusal, a pause, not reached) and even when the configuration cannot be read,
as long as the light is known.

When it cannot leave, it is **kept** (also across a restart) and sent again
every 10 s, at once when a connection to the light opens, and as soon as the
cloud gives the light (after a restart, its key comes from the cloud first).
Sent, it is checked by a read right after: off, it is done; still on after the
light answered it, it is sent again 10 s later. It ends once the light shows it
off, when the light is turned on again in the app or at the switch after the
Off was answered (never undone), when a newer command of that light leaves, or
when the device is deleted in Gladys.

An Off is refused only when replaced by a newer click on the same light before
it left. Once the light has answered it 4 times without showing it off, it is
no longer sent again by itself: the status says so; click Off again.

## Status

The Configuration page shows the state of the cloud (signed in, refused, asked
to wait, not reached), the number of lights, those reachable on the network,
the lights to add, and every Off held.

## Troubleshooting

- "unreachable": the light is off at the mains, or on another network than
  Gladys; new tries after 5 or 15 s, then 30 s, 1, 2, then every 5 minutes, and
  a discovery every 5 minutes at most.
- "another light or another key": the key changed (light reset or paired
  again): the list is read again from the cloud (a minute apart at most).
- Nothing in Discover: only the lights with a local key are listed (Wi-Fi
  lights of the AiDot app, in a home you own).
