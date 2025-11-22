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
  // Text area for sampling background brightness
  TEXT_AREA_X: 51,
  TEXT_AREA_Y: 60,
  TEXT_AREA_WIDTH: 922,
  TEXT_AREA_HEIGHT: 280,
  TEXT_PADDING_HORIZONTAL: 30,
  TEXT_PADDING_VERTICAL: 20,
  FONT_SIZE_MAX: 120,
  FONT_SIZE_MIN: 80,
  FONT_SIZE_STEP: 2,
  // Stronger shadow for text without backdrop
  TEXT_SHADOW_LIGHT: {
    color: 'rgba(0, 0, 0, 0.8)',
    blur: 8,
    offsetX: 3,
    offsetY: 3
  },
  TEXT_SHADOW_DARK: {
    color: 'rgba(255, 255, 255, 0.8)',
    blur: 8,
    offsetX: 3,
    offsetY: 3
  },
  // Stroke for extra readability
  STROKE_WIDTH: 4
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
 * Calculate average brightness of a region in the image
 * Returns a value between 0 (dark) and 255 (light)
 */
function calculateRegionBrightness(ctx, x, y, width, height) {
  const imageData = ctx.getImageData(x, y, width, height)
  const data = imageData.data
  let totalBrightness = 0
  let pixelCount = 0

  // Sample every 10th pixel for performance
  for (let i = 0; i < data.length; i += 40) { // 4 channels * 10 = 40
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    // Use perceived brightness formula (human eye is more sensitive to green)
    const brightness = (0.299 * r + 0.587 * g + 0.114 * b)
    totalBrightness += brightness
    pixelCount++
  }

  return totalBrightness / pixelCount
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

    const fontPath = path.join(__dirname, '..', 'fonts', fontFileName)
    console.log(`Attempting to register font: ${fontPath}`)

    // Debug: Verify file exists and is readable
    const fs = require('fs')
    try {
      const stats = fs.statSync(fontPath)
      console.log(`Font file size: ${stats.size} bytes`)
      console.log(`Font file permissions: ${stats.mode.toString(8)}`)
    } catch (err) {
      console.error(`Error checking font file: ${err.message}`)
      throw new Error(`Font file not accessible: ${fontPath}`)
    }

    // Try registering font with explicit family name first
    GlobalFonts.registerFromPath(fontPath, styleConfig.fontFamily)

    // Check what fonts are now available
    let families = GlobalFonts.families
    console.log(`After first registration: ${JSON.stringify(families)}`)

    // Check if our font registered with proper styles
    let fontFamily = families.find(f => f.family === styleConfig.fontFamily)

    if (!fontFamily || fontFamily.styles.length === 0) {
      console.log(`⚠️ Font registered with empty styles, trying without explicit family name...`)

      // Try registering without family name - let font use its internal name
      GlobalFonts.registerFromPath(fontPath)
      families = GlobalFonts.families
      console.log(`After second registration: ${JSON.stringify(families)}`)

      // Try to find any font that was just registered
      fontFamily = families.find(f =>
        f.family.toLowerCase().includes(styleConfig.fontFamily.toLowerCase()) ||
        f.styles.length > 0
      )
    }

    const fontFamilyToUse = fontFamily ? fontFamily.family : styleConfig.fontFamily
    const hasStyles = fontFamily && fontFamily.styles.length > 0

    console.log(`Using font family: "${fontFamilyToUse}"`)
    console.log(`Font has styles: ${hasStyles}`)
    console.log(`Font styles: ${fontFamily ? JSON.stringify(fontFamily.styles) : 'none'}`)

    // 2. Create canvas with image dimensions
    const canvas = createCanvas(
      OVERLAY_CONFIG.IMAGE_WIDTH,
      OVERLAY_CONFIG.IMAGE_HEIGHT
    )
    const ctx = canvas.getContext('2d')

    // 3. Load and draw background image
    const img = await loadImage(backgroundImageBuffer)
    ctx.drawImage(img, 0, 0, OVERLAY_CONFIG.IMAGE_WIDTH, OVERLAY_CONFIG.IMAGE_HEIGHT)

    // 4. Calculate background brightness where text will be placed
    const avgBrightness = calculateRegionBrightness(
      ctx,
      OVERLAY_CONFIG.TEXT_AREA_X,
      OVERLAY_CONFIG.TEXT_AREA_Y,
      OVERLAY_CONFIG.TEXT_AREA_WIDTH,
      OVERLAY_CONFIG.TEXT_AREA_HEIGHT
    )
    console.log(`Average background brightness: ${avgBrightness.toFixed(1)}`)

    // Determine text color based on background brightness
    // If background is light (>128), use dark text; otherwise use light text
    const isLightBackground = avgBrightness > 128
    const textColor = isLightBackground ? '#000000' : '#FFFFFF'
    const strokeColor = isLightBackground ? '#FFFFFF' : '#000000'
    const textShadow = isLightBackground ? OVERLAY_CONFIG.TEXT_SHADOW_DARK : OVERLAY_CONFIG.TEXT_SHADOW_LIGHT

    console.log(`Background is ${isLightBackground ? 'light' : 'dark'}, using ${textColor} text`)

    // 5. Calculate optimal font size
    const maxTextWidth = OVERLAY_CONFIG.TEXT_AREA_WIDTH - (OVERLAY_CONFIG.TEXT_PADDING_HORIZONTAL * 2)
    const fontSize = calculateOptimalFontSize(
      ctx,
      text,
      fontFamilyToUse,
      maxTextWidth
    )

    // 6. Configure text rendering
    // Use weight 700 instead of 'bold' for better compatibility
    const fontWeight = hasStyles ? '700' : 'bold'
    ctx.font = `${fontWeight} ${fontSize}px "${fontFamilyToUse}"`
    console.log(`Setting canvas font to: ${ctx.font}`)
    console.log(`Auto-detected text color: ${textColor}`)
    console.log(`Text to render: "${text}"`)

    // Test if font is actually working by measuring text
    const testMetrics = ctx.measureText(text)
    console.log(`Text width measurement: ${testMetrics.width}px`)

    if (testMetrics.width === 0) {
      console.warn(`⚠️ Font measurement returned 0, font may not be working. Trying fallback...`)
      // Try without weight specification
      ctx.font = `${fontSize}px "${fontFamilyToUse}"`
      const fallbackMetrics = ctx.measureText(text)
      console.log(`Fallback text width: ${fallbackMetrics.width}px`)

      if (fallbackMetrics.width === 0) {
        console.error(`❌ Font completely failed. Using Arial fallback.`)
        ctx.font = `bold ${fontSize}px Arial`
      }
    }

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    // 7. Calculate center position for text
    const textX = OVERLAY_CONFIG.TEXT_AREA_X + (OVERLAY_CONFIG.TEXT_AREA_WIDTH / 2)
    const textY = OVERLAY_CONFIG.TEXT_AREA_Y + (OVERLAY_CONFIG.TEXT_AREA_HEIGHT / 2)

    // 8. Draw text stroke (outline) for readability
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = OVERLAY_CONFIG.STROKE_WIDTH
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2
    ctx.strokeText(text, textX, textY)

    // 9. Apply text shadow
    ctx.shadowColor = textShadow.color
    ctx.shadowBlur = textShadow.blur
    ctx.shadowOffsetX = textShadow.offsetX
    ctx.shadowOffsetY = textShadow.offsetY

    // 10. Draw filled text on top
    ctx.fillStyle = textColor
    ctx.fillText(text, textX, textY)

    // 11. Export as PNG buffer
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
