# Text Overlay Microservice

A standalone serverless function for applying text overlays to images using `@napi-rs/canvas`.

## Why a Separate Service?

This service runs as a plain Vercel serverless function (no Next.js) to avoid webpack bundling issues with the native `@napi-rs/canvas` module. Next.js API routes always go through webpack, which cannot properly bundle native Node.js modules.

## Architecture

- **Plain Node.js serverless function** - No webpack involvement
- **@napi-rs/canvas** - Native canvas implementation for image processing
- **Vercel deployment** - Runs on Vercel's serverless infrastructure

## API Endpoint

### POST /api/overlay

Apply text overlay to an image.

**Request Body:**
```json
{
  "imageUrl": "https://example.com/background.png",
  "text": "Hello World",
  "styleConfig": {
    "fontFamily": "Inter",
    "backdropColor": "#4A90A4",
    "backdropOpacity": 0.85,
    "textColor": "#FFFFFF"
  }
}
```

**Response:**
- Content-Type: `image/png`
- Body: PNG image buffer with text overlay applied

**Authentication:**
- Include `Authorization: Bearer <API_KEY>` header if API_KEY is configured

## Deployment

### Prerequisites

1. Install Vercel CLI:
```bash
npm install -g vercel
```

2. Login to Vercel:
```bash
vercel login
```

### Deploy

1. Navigate to this directory:
```bash
cd text-overlay-service
```

2. Install dependencies:
```bash
npm install
```

3. Deploy to production:
```bash
vercel --prod
```

4. Set environment variable (optional):
```bash
vercel env add API_KEY
```

### Local Development

```bash
npm run dev
```

This starts a local Vercel development server on http://localhost:3000

## Integration with Main App

In your Next.js app, call this service:

```typescript
const response = await fetch(`${process.env.TEXT_OVERLAY_SERVICE_URL}/api/overlay`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.TEXT_OVERLAY_API_KEY}`
  },
  body: JSON.stringify({
    imageUrl: backgroundImageUrl,
    text: overlayText,
    styleConfig: {
      fontFamily: 'Inter',
      backdropColor: '#4A90A4',
      backdropOpacity: 0.85,
      textColor: '#FFFFFF'
    }
  })
})

const imageBuffer = await response.arrayBuffer()
```

## Supported Fonts

- Inter (Inter-Bold.ttf)
- Poppins (Poppins-Bold.ttf)
- Montserrat (Montserrat-Bold.ttf)
- Oswald (Oswald-SemiBold.ttf)

## Environment Variables

- `API_KEY` (optional) - Bearer token for API authentication
