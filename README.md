# ClaudeSync

Seamlessly integrate your VS Code workspace with Claude.ai projects. ClaudeSync keeps your local files in perfect harmony with your Claude.ai conversations, making it easier than ever to collaborate with Claude on your development projects.

> This extension requires a Claude.ai account with the Pro plan.

## Quick Start Guide

### 1. Install the Extension

You can install ClaudeSync directly from the [VS Code Marketplace](https://marketplace.visualstudio.com/PLACEHOLDER)!

### 2. Get Your Claude Token

To connect ClaudeSync with your Claude.ai account, you'll need your session token. Here's how to get it:

1. Visit [claude.ai](https://claude.ai) and sign in to your account.
2. Open Developer Tools:
   - Windows/Linux: `F12` or `Ctrl+Shift+I`
   - Mac: `Cmd+Option+I`
3. Navigate to: `Application → Cookies → claude.ai → sessionKey`
4. Copy the token value (starts with "sk-ant")

> Tip: Make sure you copy the raw token value, not the URL-encoded version!

### 3. Configure the Extension

1. Open the Command Palette in VS Code:
   - Windows/Linux: `Ctrl+Shift+P`
   - Mac: `Cmd+Shift+P`
2. Type "ClaudeSync: Set Token"
3. Paste your Claude session token
4. You're ready to go!

## Available Commands

Access these commands through the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`):

| Command                                 | Description                                   |
| --------------------------------------- | --------------------------------------------- |
| `ClaudeSync: Set Token`                 | Configure your Claude session token           |
| `ClaudeSync: Initialize Project`        | Set up a new Claude project for the workspace |
| `ClaudeSync: Sync Current File`         | Sync the active file                          |
| `ClaudeSync: Sync Workspace`            | Sync all workspace files                      |
| `ClaudeSync: Configure Auto-sync`       | Manage automatic file syncing                 |
| `ClaudeSync: Configure Startup Sync`    | Control syncing on VS Code startup            |
| `ClaudeSync: Sync Project Instructions` | Update project instructions                   |
| `ClaudeSync: Open in Browser`           | View project in Claude.ai's Web UI            |

## Configuration

Customize ClaudeSync through `.vscode/claudesync.json`:

```json
{
  "excludePatterns": [
    "node_modules/**",
    "dist/**",
    ".git/**"
    // ... other patterns
  ],
  "maxFileSize": 1048576, // 1MB
  "autoSync": false,
  "autoSyncDelay": 30,
  "syncOnStartup": false
}
```

### Configuration Options

| Option            | Description                      | Default   |
| ----------------- | -------------------------------- | --------- |
| `excludePatterns` | Glob patterns for excluded files | `[]`      |
| `maxFileSize`     | Maximum file size (bytes)        | `1048576` |
| `autoSync`        | Enable automatic syncing         | `false`   |
| `autoSyncDelay`   | Sync delay (seconds)             | `30`      |
| `syncOnStartup`   | Sync when VS Code starts         | `false`   |

## Project Instructions

Need to give Claude specific instructions for your project? Create a `.projectinstructions` file in your workspace root. These instructions sync when initializing a new project, or when running "Sync Project Instructions" manually.

## Contributing

Feel free to contribute to this project by opening an issue or submitting a pull request.

## License

ClaudeSync is open source software licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

---

> ⚠️ Note: This extension is not officially affiliated with Anthropic's Claude.ai service.
