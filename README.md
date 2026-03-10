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

## GitHub Actions deployment

This repo includes:

- CI: syntax check + Docker build on pull requests and pushes to `main`
- Deploy: build Docker image, push to GHCR, then SSH into your server and restart the container

### Required GitHub Actions secrets

- `DEPLOY_HOST`: server IP or hostname
- `DEPLOY_PORT`: SSH port, usually `22`
- `DEPLOY_USER`: SSH user on the target server
- `DEPLOY_SSH_KEY`: private key for that user

### Remote server requirements

- Docker installed
- The deploy user can run `docker`
- Port `3000` exposed, or change the workflow mapping if you want another port

### Deployment behavior

On every push to `main`, GitHub Actions will:

1. Build the Docker image
2. Push it to `ghcr.io/<owner>/podcast-summary-web:latest`
3. SSH into your server
4. Pull the latest image
5. Recreate the `podcast-summary-web` container
