/**
 * Text Overlay Microservice
 *
 * A standalone serverless function for applying text overlays to images
 * using @napi-rs/canvas (native Node.js module).
 *
 * This runs as a plain Vercel serverless function (no Next.js webpack bundling).
 */

const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas')
const path = require('path')

/**
 * Overlay configuration
 */
const OVERLAY_CONFIG = {
  IMAGE_WIDTH: 1024,
  IMAGE_HEIGHT: 1024,
  BANNER_X: 51,
  BANNER_Y: 60,
  BANNER_WIDTH: 922,
  BANNER_HEIGHT: 280,
  TEXT_PADDING_HORIZONTAL: 30,
  TEXT_PADDING_VERTICAL: 20,
  FONT_SIZE_MAX: 80,
  FONT_SIZE_MIN: 60,
  FONT_SIZE_STEP: 2,
  TEXT_SHADOW: {
    color: 'rgba(0, 0, 0, 0.5)',
    blur: 4,
    offsetX: 2,
    offsetY: 2
  }
}

/**
 * Font mappings (same as palette-style-mappings.ts)
 */
const FONT_FAMILIES = {
  'Inter': 'Inter-Bold.ttf',
  'Poppins': 'Poppins-Bold.ttf',
  'Montserrat': 'Montserrat-Bold.ttf',
  'Oswald': 'Oswald-SemiBold.ttf'
}

/**
 * Convert hex color to RGB values
 */
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) {
    throw new Error(`Invalid hex color: ${hex}`)
  }
  return {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  }
}

/**
 * Convert hex color to RGBA string with opacity
 */
function hexToRGBA(hex, opacity) {
  const rgb = hexToRgb(hex)
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`
}

/**
 * Calculate optimal font size for text to fit within available width
 */
function calculateOptimalFontSize(ctx, text, fontFamily, maxWidth) {
  let fontSize = OVERLAY_CONFIG.FONT_SIZE_MAX

  while (fontSize >= OVERLAY_CONFIG.FONT_SIZE_MIN) {
    ctx.font = `bold ${fontSize}px "${fontFamily}"`
    const metrics = ctx.measureText(text)

    if (metrics.width <= maxWidth) {
      return fontSize
    }

    fontSize -= OVERLAY_CONFIG.FONT_SIZE_STEP
  }

  console.warn(`Text "${text}" may be too long for banner at ${OVERLAY_CONFIG.FONT_SIZE_MIN}px`)
  return OVERLAY_CONFIG.FONT_SIZE_MIN
}

/**
 * Apply text overlay to background image
 */
async function applyTextOverlay(backgroundImageBuffer, text, styleConfig) {
  try {
    // 1. Register font
    const fontFileName = FONT_FAMILIES[styleConfig.fontFamily]
    if (!fontFileName) {
      throw new Error(`Unknown font family: ${styleConfig.fontFamily}`)
    }

    const fontPath = path.join(__dirname, 'fonts', fontFileName)
    console.log(`Attempting to register font: ${fontPath}`)

    const registered = GlobalFonts.registerFromPath(fontPath, styleConfig.fontFamily)
    console.log(`Font registration result: ${registered}`)

    if (!registered) {
      throw new Error(`Failed to register font: ${fontPath}`)
    }

    // 2. Create canvas with image dimensions
    const canvas = createCanvas(
      OVERLAY_CONFIG.IMAGE_WIDTH,
      OVERLAY_CONFIG.IMAGE_HEIGHT
    )
    const ctx = canvas.getContext('2d')

    // 3. Load and draw background image
    const img = await loadImage(backgroundImageBuffer)
    ctx.drawImage(img, 0, 0, OVERLAY_CONFIG.IMAGE_WIDTH, OVERLAY_CONFIG.IMAGE_HEIGHT)

    // 4. Draw semi-transparent backdrop rectangle
    const backdropRGBA = hexToRGBA(
      styleConfig.backdropColor,
      styleConfig.backdropOpacity
    )
    ctx.fillStyle = backdropRGBA
    ctx.fillRect(
      OVERLAY_CONFIG.BANNER_X,
      OVERLAY_CONFIG.BANNER_Y,
      OVERLAY_CONFIG.BANNER_WIDTH,
      OVERLAY_CONFIG.BANNER_HEIGHT
    )

    // 5. Calculate optimal font size
    const maxTextWidth = OVERLAY_CONFIG.BANNER_WIDTH - (OVERLAY_CONFIG.TEXT_PADDING_HORIZONTAL * 2)
    const fontSize = calculateOptimalFontSize(
      ctx,
      text,
      styleConfig.fontFamily,
      maxTextWidth
    )

    // 6. Configure text rendering
    ctx.font = `bold ${fontSize}px "${styleConfig.fontFamily}"`
    ctx.fillStyle = styleConfig.textColor
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    // 7. Apply text shadow for readability
    ctx.shadowColor = OVERLAY_CONFIG.TEXT_SHADOW.color
    ctx.shadowBlur = OVERLAY_CONFIG.TEXT_SHADOW.blur
    ctx.shadowOffsetX = OVERLAY_CONFIG.TEXT_SHADOW.offsetX
    ctx.shadowOffsetY = OVERLAY_CONFIG.TEXT_SHADOW.offsetY

    // 8. Calculate center position for text
    const textX = OVERLAY_CONFIG.BANNER_X + (OVERLAY_CONFIG.BANNER_WIDTH / 2)
    const textY = OVERLAY_CONFIG.BANNER_Y + (OVERLAY_CONFIG.BANNER_HEIGHT / 2)

    // 9. Draw text
    ctx.fillText(text, textX, textY)

    // 10. Export as PNG buffer
    return canvas.toBuffer('image/png')
  } catch (error) {
    console.error('Error applying text overlay:', error)
    throw error
  }
}

/**
 * Fetch image from URL
 */
async function fetchImageFromUrl(url) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

/**
 * API Handler
 */
module.exports = async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  // Handle OPTIONS for CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    // Verify API key if configured
    const apiKey = process.env.API_KEY
    if (apiKey) {
      const authHeader = req.headers.authorization
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid authorization header' })
      }
      const providedKey = authHeader.substring(7)
      if (providedKey !== apiKey) {
        return res.status(403).json({ error: 'Invalid API key' })
      }
    }

    // Parse request body
    const { imageUrl, text, styleConfig } = req.body

    // Validate required fields
    if (!imageUrl) {
      return res.status(400).json({ error: 'Missing required field: imageUrl' })
    }
    if (!text) {
      return res.status(400).json({ error: 'Missing required field: text' })
    }
    if (!styleConfig) {
      return res.status(400).json({ error: 'Missing required field: styleConfig' })
    }

    // Validate styleConfig has required fields
    const requiredStyleFields = ['fontFamily', 'backdropColor', 'backdropOpacity', 'textColor']
    for (const field of requiredStyleFields) {
      if (!(field in styleConfig)) {
        return res.status(400).json({ error: `Missing required styleConfig field: ${field}` })
      }
    }

    console.log(`Processing text overlay: "${text}" on image: ${imageUrl}`)

    // Fetch the background image
    const backgroundImageBuffer = await fetchImageFromUrl(imageUrl)

    // Apply text overlay
    const resultBuffer = await applyTextOverlay(backgroundImageBuffer, text, styleConfig)

    // Return the result as PNG
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Content-Length', resultBuffer.length)
    return res.status(200).send(resultBuffer)

  } catch (error) {
    console.error('Error processing request:', error)
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    })
  }
}
