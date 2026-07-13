# Env Var Missing: Injection + Persistence Workflow

Trigger: user reports 401 from a custom provider, and the `echo "${VAR_NAME:-(NOT SET)}"` check shows the env var is missing.

## Steps

1. **Verify:** run `echo "${VAR_NAME:-(NOT SET)}"` in terminal to confirm unset
2. **Inject into current session:** `export VAR_NAME="the-key-value"`
3. **Persist to ~/.hermes/.env** (Hermes's own env file — read at every startup regardless of how the process was launched):

```bash
# Ensure a newline before appending
tail -c1 ~/.hermes/.env | read -r _ || echo >> ~/.hermes/.env
echo "VAR_NAME=the-key-value" >> ~/.hermes/.env
```

> **Why ~/.hermes/.env instead of ~/.zshrc?** Hermes processes launched via macOS launchd, Docker, cron, or non-interactive shells do NOT source ~/.zshrc. But Hermes ALWAYS reads ~/.hermes/.env at startup. All built-in provider keys (VOLC_ARK_API_KEY, DEEPSEEK_API_KEY, etc.) are already stored there. Adding custom provider keys to the same file eliminates the "zshrc-only" blind spot.

4. **(Optional) Also add to ~/.zshrc** if the user also needs the variable in interactive shell sessions (e.g., for curl commands):

4. **Verify API connectivity** with a curl:

```bash
curl -s https://api.siliconflow.cn/v1/models \
  -H "Authorization: Bearer $VAR_NAME" | jq -r '.data[].id' | head -5
# Expect HTTP 200 + model list
```

5. **Tell the user:** key is set and persisted. The current Hermes session still uses the old provider config — `/reset` is needed for native Hermes to pick it up.

## Key Points

- **Do not** ask the user to run the commands themselves — execute all steps in terminal
- The grep-and-inject pattern handles: first-time add, replacement of stale key, and skipping if already correct
- After step 3, `source ~/.zshrc` is NOT needed — the export in step 2 already covered the current session
- After step 4, the provider works from the shell. Hermes itself (`hermes config set`) may still need `/reset` if the key was empty at session start

## Example (SiliconFlow)

```bash
# Step 1: check
echo "${SILICONFLOW_API_KEY:-(NOT SET)}"

# Step 2: inject
export SILICONFLOW_API_KEY="sk-xxx..."

# Step 3: persist
grep -q 'export SILICONFLOW_API_KEY=' ~/.zshrc \
  && sed -i '' "s|^export SILICONFLOW_API_KEY=.*|export SILICONFLOW_API_KEY=\"sk-xxx...\"|" ~/.zshrc \
  || echo "export SILICONFLOW_API_KEY=\"sk-xxx...\"" >> ~/.zshrc

# Step 4: verify
curl -s https://api.siliconflow.cn/v1/models \
  -H "Authorization: Bearer $SILICONFLOW_API_KEY" | jq -r '.data[].id' | head -5
```
