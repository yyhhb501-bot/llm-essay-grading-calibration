# ViceMe CLI shared Widgets

Onboarding is a host-rendered HTML fragment. Payment provides a complete WeChat
Pay cashier page and a PNG QR image. The Agent presents them through a channel
the current host explicitly supports. Neither is a payment authority.
The CLI owns the templates; callers own their workflows. No
external scripts, images, clipboard API, HTTP polling, order creation or
business actions belong inside a Widget.

Hosts may remove script elements and evaluate their contents separately. Templates
locate an uninitialized card through the host-scoped `document.querySelector`,
then use that element's `ownerDocument` for DOM methods and lifecycle listeners.
Do not depend on `document.currentScript`, script adjacency, or prototype methods
being present on a host's scoped document/window facade. Initialization is marked
per card so replaying a script does not duplicate examples or timers.

## Payment

When local generation succeeds, the command returns `paymentPresentation.widgetPath` (a complete WeChat Pay
page), `paymentPresentation.imagePath` (a local PNG), and
`paymentPresentation.imageChatSrc` (`local-file://` plus that absolute path).
Host capabilities, image syntax, browser tools, preferences, and fallbacks are
owned by [the shared host presentation guide](host-presentation.md).
In packaged runtimes it is the sibling `host-presentation.md` under `guides/`.
The CLI embeds that same source and Python reads the packaged resource; neither
maintains a separate host-policy branch. Follow the invoking purchase flow for
payment state, amounts, and waiting.

The page background is transparent, with a centered cashier card. The local
page is presentation only and never reports task or installation completion.
Visible copy is the green WeChat poster, amount, countdown, QR, and merchant title. The countdown uses the order's absolute `expiresAt` and hides the QR at expiry. Expiry is not proof of failure or a reason to create a new order.

The official hosted cashier may poll its restricted read-only order snapshot
and show server-confirmed payment status. It cannot install Skills, consume
trials, or grant entitlements. Local Widgets remain network-free.

Callers may supply `resultTitle` and `resultDescription` for a confirmed `PAID`
snapshot. The template then hides the entire cashier (including the QR,
countdown and scan instructions) and shows a plain acknowledgement card. These
fields have no effect while payment is pending or unconfirmed. They never
trigger a business action.

Website Replica's opt-in `--payment-result-first` wait returns
`PRESENT_SUPPORT_RESULT` before downloading. The host explicitly presents its
`presentation.widgetPath`, a separate `.support.html` file, to replace the
active preview; rewriting a previously opened file does not prove a host has
refreshed it. The caller then executes the returned recovery-only continuation
for the same purchase, preserving `--expected-order-no` as the returned
`orderNo`. A different local purchase must stop instead of taking over delivery.
Presentation failure retains the payment fact and must
not trigger another purchase. The historical chat PNG is not a live status UI.

## Onboarding

The caller's `use-a-skill` installation guide decides when to show onboarding,
including after confirming an existing installation. This section only owns
example presentation; it does not install Skills or decide usage eligibility.
Once the caller selects onboarding, read the installed `SKILL.md` and generate
2–3 genuinely supported, complete prompts and short titles. Use the same layout
for every Skill: no invented capabilities, categories or bespoke UI.

Replace `__WIDGET_DATA__` in `onboarding.html` with JSON containing `skillName`,
`locale` (`zh-CN` or `en-US`), and `examples: [{title, prompt}]`. JSON-encode
strings and escape `<`, `>`, `&`, U+2028 and U+2029 as Unicode escapes so authored
content cannot end the script tag. Never insert prompt text with `innerHTML`.
On WorkBuddy call `read_me({modules:["interactive"]})`, then actually invoke
`show_widget` with the filled template. A text list is not a rendered Widget.
`sendPrompt(string)` sends the chosen prompt as a new conversation message.
Displaying examples does not execute a task or consume quota; the receiving
Agent follows the installed trial precheck before executing the chosen task.

Without Widget support, present the same 2–3 prompts as ordinary text. Clipboard
access is not required. A failed template request or rendering error is not proof
that the host lacks Widget support; report it instead of silently falling back.
Source templates are published with the CLI release at
`/skills/_widgets/`; this is a shared resource directory, not an installed Skill.

Installers bundle these templates, guides, the Python runtime and QR encoder in
each product's `.viceme/` directory. Use the returned local paths after install;
do not fetch static resources or probe updates during onboarding, use or payment.
Only first-time no-CLI bootstrap downloads one content-addressed runtime archive
and verifies its pinned SHA-256. `qrcodegen.py` is MIT code from
Project Nayuki with trailing whitespace normalized and no logic changes,
revision `3c6d0b3cefb4e049dc337e82237c9644399716a8`:
https://github.com/nayuki/QR-Code-generator/blob/3c6d0b3cefb4e049dc337e82237c9644399716a8/python/qrcodegen.py
Its license is retained in the source. Payment URIs are encoded locally and are
never sent to a third-party QR service. Content-addressed hosted resources must
remain available for older scripts; do not delete previous hashes at release.
