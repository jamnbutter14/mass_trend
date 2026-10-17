# Trend Content Generator (Vercel)

Your Gemini key stays on the server. Visitors only need the access code you give them.

## Files
- `public/index.html` – the website
- `api/generate.js` – server function that talks to Gemini
- `vercel.json`, `package.json` – config

## Deploy (GitHub method, no coding needed)
1. Create a free account at github.com and make a new **private** repository.
2. Upload everything in this folder to it (keep the `api` and `public` folders as they are).
3. Create a free account at vercel.com (sign in with GitHub).
4. Click **Add New > Project**, pick your repository, leave all settings as default.
5. Before pressing Deploy, open **Environment Variables** and add:
   - `GEMINI_API_KEY` = your NEW Gemini key (not the one you shared earlier)
   - `ACCESS_CODE` = a code of your choice, e.g. `fandom-2026-xyz`
   - Optional: `RATE_LIMIT_PER_HOUR` (default 60 requests per person), `DAILY_CAP` (default 3000 requests per day), `GEMINI_MODEL` (default gemini-3.8-flash)
6. Press **Deploy**. You get a link like `your-project.vercel.app`. Share the link plus the access code.

If you change an environment variable later, go to Deployments and press **Redeploy**.

## Deploy (command line alternative)
```
npm i -g vercel
cd this-folder
vercel login
vercel
vercel env add GEMINI_API_KEY production
vercel env add ACCESS_CODE production
vercel --prod
```

## Good to know
- One "round" of 100 comments uses about 5 to 20 requests, so the default 60 per hour allows a few rounds per person. Raise `RATE_LIMIT_PER_HOUR` if needed.
- The rate limit and daily cap are tracked in server memory, so they are approximate and can reset when Vercel restarts the function. For a hard cap, set a spending limit and quota in Google AI Studio / Google Cloud as well.
- To change the access code, edit `ACCESS_CODE` in Vercel and redeploy. Everyone must then enter the new code.
