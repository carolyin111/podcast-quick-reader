# Podcast Summary Web

Standalone web app version of the existing `n8n` podcast summary workflow.

## Run

```bash
npm start
```

Open `http://localhost:3000`.

## What it does

- Accepts a podcast episode URL, Apple Podcasts episode URL, or direct audio URL
- Tries to resolve the underlying audio file from the page
- For Apple Podcasts links, looks up the show's RSS feed and matches the episode automatically
- Sends the audio to AssemblyAI for transcription, summary, highlights, and chapters
- Shows a heuristic score for whether the episode is worth a full listen

## Notes

- Requires your own AssemblyAI API key
- A long episode can take several minutes because the server polls AssemblyAI until transcription completes

## Deployment

### GitHub Actions

This repo keeps a lightweight CI workflow in [.github/workflows/ci.yml](/Users/carolyin/codex/.github/workflows/ci.yml):

- Validate `server.js` syntax
- Build the Docker image

### Zeabur

This repo is configured for Zeabur deployment:

- [Dockerfile](/Users/carolyin/codex/Dockerfile) builds the app container
- [zeabur.json](/Users/carolyin/codex/zeabur.json) declares port `3000` and `/health`
- [server.js](/Users/carolyin/codex/server.js) listens on `0.0.0.0` and exposes `/health`

To deploy on Zeabur:

1. Create a project in Zeabur
2. Import GitHub repo `carolyin111/podcast-quick-reader`
3. Let Zeabur detect the Dockerfile or use the included `zeabur.json`
4. Deploy the service
5. Bind a domain in Zeabur if needed

You do not need GitHub Actions deploy secrets for Zeabur. Pushes to GitHub can trigger redeploys through Zeabur's GitHub integration.
