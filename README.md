# ClaudeSync

Seamlessly integrate your VS Code workspace with Claude.ai projects. ClaudeSync keeps your local files in perfect harmony with your Claude.ai conversations, making it easier than ever to collaborate with Claude on your development projects.

> This extension requires a Claude.ai account with the Pro plan.

## Quick Start Guide

### 1. Install the Extension

You can install ClaudeSync directly from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=rexdotsh.claudesync)!

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

| Command                                     | Description                                   |
| ------------------------------------------- | --------------------------------------------- |
| `ClaudeSync: Set Token`                     | Configure your Claude session token           |
| `ClaudeSync: Initialize Project`            | Set up a new Claude project for the workspace |
| `ClaudeSync: Sync Current File`             | Sync the active file                          |
| `ClaudeSync: Sync Workspace`                | Sync all workspace files                      |
| `ClaudeSync: Configure Auto-sync`           | Manage automatic file syncing                 |
| `ClaudeSync: Configure Startup Sync`        | Control syncing on VS Code startup            |
| `ClaudeSync: Sync Project Instructions`     | Update project instructions                   |
| `ClaudeSync: Open in Browser`               | View project in Claude.ai's Web UI            |
| `ClaudeSync: Configure Remote File Cleanup` | Configure cleanup of remote files             |
| `ClaudeSync: Show Current Settings`         | Display current extension settings            |
| `ClaudeSync: Exclude from Sync`             | Exclude specific files from syncing           |
| `ClaudeSync: Include in Sync`               | Include previously excluded files in syncing  |
| `ClaudeSync: Show Output Channel`           | Show the extension's output/logs              |

## Configuration

Customize ClaudeSync through `.vscode/claudesync.json`:

```json
{
  "excludePatterns": [
    "node_modules/**",
    ".git/**",
    "dist/**",
    "build/**",
    "**/*.pyc",
    "**/__pycache__/**",
    ".env"
    // ... many other patterns
  ],
  "maxFileSize": 2097152, // 2MB
  "autoSync": false,
  "autoSyncDelay": 30,
  "syncOnStartup": false,
  "cleanupRemoteFiles": false
}
```

### Configuration Options

| Option               | Description                                             | Default           |
| -------------------- | ------------------------------------------------------- | ----------------- |
| `excludePatterns`    | Glob patterns for excluded files                        | See example above |
| `maxFileSize`        | Maximum file size in bytes                              | `2097152` (2MB)   |
| `autoSync`           | Enable automatic file syncing                           | `false`           |
| `autoSyncDelay`      | Delay in seconds between auto-syncs (min: 10, max: 180) | `30`              |
| `syncOnStartup`      | Sync workspace when VS Code starts                      | `false`           |
| `cleanupRemoteFiles` | Remove remote files that don't exist locally            | `false`           |

## Project Instructions

Need to give Claude specific instructions for your project? Create a `.projectinstructions` file in your workspace root. These instructions sync when initializing a new project, or when running "Sync Project Instructions" manually.

## Contributing

Feel free to contribute to this project by opening an issue or submitting a pull request.

## License

ClaudeSync is open source software licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

---

> ⚠️ Note: This extension is not officially affiliated with Anthropic's Claude.ai service.
