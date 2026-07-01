# WillViral — Creator Intelligence Platform

> Magyar créatoroknak. Találd meg a következő sikeres videódat.

## Stack

- **Frontend:** Next.js 14 + React + Tailwind CSS
- **Backend:** Vercel Serverless Functions (Next.js API Routes)
- **Database:** Supabase (PostgreSQL + Auth + RLS)
- **AI:** Claude API (claude-sonnet-4-5)
- **Data:** YouTube Data API v3

---

## Telepítés

### 1. Repo klónozása

```bash
git clone https://github.com/Tubegenius/tubegenius-hu.git
cd tubegenius-hu
npm install
```

### 2. Supabase projekt létrehozása

1. Menj a [supabase.com](https://supabase.com) oldalra
2. Hozz létre egy új projektet
3. Menj a **SQL Editor** menübe
4. Másold be és futtasd a `supabase/migrations/001_initial_schema.sql` tartalmát

### 3. Environment variables

Másold a `.env.example` fájlt `.env.local` névvel:

```bash
cp .env.example .env.local
```

Töltsd ki a következő értékeket:

```
NEXT_PUBLIC_SUPABASE_URL=       # Supabase projekt URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=  # Supabase anon key
SUPABASE_SERVICE_ROLE_KEY=      # Supabase service role key
ANTHROPIC_API_KEY=              # Anthropic API key
YOUTUBE_API_KEY=                # YouTube Data API v3 key
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

### 4. Fejlesztői szerver indítása

```bash
npm run dev
```

Nyisd meg: [http://localhost:3000](http://localhost:3000)

---

## Vercel Deploy

### Environment Variables beállítása Vercelen

A Vercel dashboard-on: **Settings → Environment Variables**

Add meg az összes `.env.example`-ben szereplő változót.

### Automatikus deploy

Minden `git push` automatikusan deploy-olja a `main` branch-et.

---

## Funkciók (MVP Sprint 1)

| Funkció | Státusz |
|---------|---------|
| Auth (Register/Login) | ✅ |
| Creator Profil | ✅ |
| Dashboard (3 belépési pont) | ✅ |
| Opportunity Engine | ✅ |
| Viral Score | ✅ |
| Similar Videos | ✅ |
| Script Extractor | ✅ |
| Creator Memory | ✅ |

---

## Architektúra

```
app/
├── auth/
│   ├── login/          # Belépés
│   ├── register/       # Regisztráció
│   └── callback/       # Auth redirect
├── dashboard/
│   ├── page.tsx        # Főoldal (3 belépési pont)
│   ├── opportunities/  # Opportunity Engine
│   ├── viral-score/    # Viral Score
│   ├── similar-videos/ # Similar Videos
│   ├── script-extractor/ # Script Extractor
│   └── profile/        # Creator Profil
└── api/
    ├── opportunity/    # Opportunity Engine API
    ├── viral-score/    # Viral Score API
    ├── similar-videos/ # Similar Videos API
    ├── script-extract/ # Script Extractor API
    └── memory/         # Creator Memory CRUD

supabase/
└── migrations/
    └── 001_initial_schema.sql

types/
└── index.ts           # TypeScript típusdefiníciók
```
