# Zen Tab Wand

A one-click tab tidier for [Zen Browser](https://zen-browser.app), installed via the [Sine](https://github.com/CosmoCreeper/Sine) mod loader. Click the wand in your toolbar, and your open tabs get sorted into groups.

## How it works

Two passes:

1. **Domain rules first.** You define groups in settings — e.g. `Shopping` matches `amazon.com`, `staples.com`, etc. Every open tab whose hostname matches a rule moves into the corresponding group.
2. **AI fallback for the rest.** Tabs the rules don't cover can be sent to a local AI engine that figures out where they belong. The AI is **optional and off by default**; you choose whether to enable it.

There's no cloud component. The AI runs on your machine via [Ollama](https://ollama.com) (recommended) or Firefox's bundled ML engine (limited).

## Installing

In Zen → Sine → Marketplace, search for "Zen Tab Wand" and install. Or sideload by dropping the source into your Sine mods folder.

After install, a wand icon appears in your toolbar's workspace separator. Right-click the icon to open settings.

## Quick start

1. Open **Settings → Zen Tab Wand**.
2. Edit the **Group Rules** table to your liking. Each group needs a name, color, and one or more domains (e.g. `Dev` → `github.com, stackoverflow.com`).
3. Click the **wand button** in the toolbar. Your matching tabs are sorted instantly.
4. (Optional) Pick an **AI engine** for tabs the rules don't cover — see below.

## AI engines

| Engine | What it does | Setup |
|---|---|---|
| **Off** | Rules only. Tabs without a matching rule stay where they are. | — |
| **Local** | Firefox's bundled tab-embedding model. Only assigns tabs to *existing* groups; conservative by design, no new groups. No setup. | None — built in. |
| **Ollama** | A local Ollama daemon. Can both assign tabs into existing groups AND invent new ones, with a merge pass and an optional interactive **Plan Mode** modal where you preview the AI's plan before applying. | Install [Ollama](https://ollama.com), then `ollama pull qwen2.5:1.5b` (or a bigger model if you have the VRAM). |

For Ollama, the default model is `qwen2.5:1.5b` (~1 GB, runs on most GPUs). If you have 8+ GB VRAM, `qwen2.5:7b` is noticeably more accurate — change the model name in settings.

## Modes when AI creates a new group

(Only relevant when the AI engine is set to Ollama.)

| Mode | What happens |
|---|---|
| **Auto-add** | AI creates the group AND saves a rule with the tabs' hostnames. Rules grow over time. Modal asks you to confirm. |
| **Transient** | AI creates the group, no rule saved. Fast, no confirmation. |
| **Prompt** | Opens Zen's edit modal for each new group so you can rename/recolor. |
| **Fresh categories** | AI re-tidies **all** tabs into fresh categories, ignoring your rules. Like Arc Browser's Tidy. |
| **Plan Mode** | Shows the proposed plan in a modal first. You toggle each group keep/skip, optionally click "Re-assign" to redo the unkept tabs, then Apply. |

## Other settings

- **Minimal style** — strips the colored backgrounds from groups for a flatter look.
- **Keep Ollama model warm** — preloads the model at browser startup and keeps it in VRAM between clicks. Faster, but uses VRAM continuously.

## Privacy

- Domain rules + their colors are saved in your Zen browser prefs. Local only.
- The Local AI runs entirely on-device using Firefox's bundled model.
- The Ollama engine talks to `localhost:11434` (or whatever host you configured). Nothing goes to the internet from this mod.
- The mod fetches `<meta name="description">` snippets from your open tab URLs (to give the AI better context). These fetches use your browser cookies and stay between your browser and the destination site — same as if you'd refreshed the tab.

## Reporting bugs

Open an issue on the source repository. Helpful to include the **Browser Console** log (Ctrl+Shift+J) around the time of the bug — the mod logs detailed diagnostics with the prefix `[AutoOrganize]`.

## License

MIT.
