# Third-party notices — ffs-notify

## takemotions-media-bridge (MIT)

The now-playing capability in this module (`MediaHub.kt`, and the TypeScript re-expression of its
three engineering fixes in `../../src/data/sources/media.ts`) is derived from the
**takemotions-media-bridge** project — the `MediaSessionManager` / `MediaController` extraction
technique behind an otherwise-empty `NotificationListenerService`, live-position projection,
paused-vs-dead session selection, and seek de-duplication.

- Project: takemotions-media-bridge — https://github.com/r-tkbyc/takemotions-media-bridge
- Copyright (c) r-tkbyc
- License: MIT

```
MIT License

Copyright (c) r-tkbyc (takemotions-media-bridge)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## appsbridge — NOT used (recorded for the avoidance of doubt)

The navigation-from-notification technique and the RemoteInput reply-back path were *observed* in
**appsbridge** (https://homeauto.cc/appsbridge), which ships with **no license (all rights
reserved)**. **No code, regex or asset from appsbridge is used in this repository.** `NavScanner.kt`,
`ReplyRegistry.kt`, and `../../src/data/sources/navigation.ts` are clean-room implementations
written against the public Android framework APIs; the nav package set and all parsers were authored
independently. appsbridge served only as a design reference.
