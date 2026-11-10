# Privacy

show-your-work runs on your computer. The pictures and videos Claude shows you, your files and your conversations stay on your machine.

## What it sends

It sends one thing, and nothing else.

**A version check.** At most once a day, it reads the plugin's latest version number from this repository on `raw.githubusercontent.com`, so it can keep itself up to date. It's an ordinary web request and carries nothing about you.

There is no telemetry: no usage counts, install id or analytics of any kind.

## Turning it off

- Updates: `SHOW_YOUR_WORK_AUTO_UPDATE=0` stops the version check.

## What it keeps on your computer

- Video frames and converted pictures, in a temp folder. Anything older than a week is deleted.
- A copy of each file Claude shows you, in `.show-your-work/` in your project, for version history. Delete the folder any time.
- Your settings, in Claude Code's storage for the plugin.
- Only if you start Claude Code with `SHOW_YOUR_WORK_DEBUG=1`: a debug log (`debug.log` in the temp folder) of what the plugin did, including file paths and window sizes, for bug reports. It stays on your computer unless you attach it to an issue yourself.

Nothing kept on your computer is sent anywhere.

## Your data

The install id is random and never linked to your name, email or account, so the usage counts can't be traced back to you.

## Questions

Open an issue at [github.com/jeffzyliu/claude-show-your-work/issues](https://github.com/jeffzyliu/claude-show-your-work/issues).
