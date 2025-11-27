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
  // Text area - left-aligned in lower third, max 75% of image width
  TEXT_AREA_X: 40,
  TEXT_AREA_Y: 684, // Start of lower third (1024 * 2/3)
  TEXT_AREA_WIDTH: 768, // 75% of 1024px
  TEXT_AREA_HEIGHT: 280,
  TEXT_PADDING_HORIZONTAL: 30,
  TEXT_PADDING_VERTICAL: 20,
  FONT_SIZE_MAX: 120,
  FONT_SIZE_MIN: 80,
  FONT_SIZE_STEP: 2,
  // Backdrop settings for text readability
  BACKDROP_OPACITY: 0.9,
  BACKDROP_PADDING: 20,
  BACKDROP_BORDER_RADIUS: 20
}

/**
 * Font mappings - using Montserrat variable font (supports all weights)
 */
const FONT_FAMILIES = {
  'Inter': 'Montserrat-VariableFont_wght.ttf',
  'Poppins': 'Montserrat-VariableFont_wght.ttf',
  'Montserrat': 'Montserrat-VariableFont_wght.ttf',
  'Oswald': 'Montserrat-VariableFont_wght.ttf',
  'Product Sans': 'Montserrat-VariableFont_wght.ttf'
}

/**
 * Draw a rounded rectangle path
 */
function drawRoundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + width - radius, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius)
  ctx.lineTo(x + width, y + height - radius)
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  ctx.lineTo(x + radius, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

/**
 * Wrap text into multiple lines to fit within maxWidth
 * Returns array of lines
 */
function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ')
  const lines = []
  let currentLine = ''

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word
    const metrics = ctx.measureText(testLine)

    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine)
      currentLine = word
    } else {
      currentLine = testLine
    }
  }

  if (currentLine) {
    lines.push(currentLine)
  }

  return lines
}

/**
 * Calculate optimal font size and wrap text to fit within available area
 * Returns { fontSize, lines }
 */
function calculateTextLayout(ctx, text, fontFamily, maxWidth, maxHeight) {
  let fontSize = OVERLAY_CONFIG.FONT_SIZE_MAX
  const lineHeightMultiplier = 1.2

  while (fontSize >= OVERLAY_CONFIG.FONT_SIZE_MIN) {
    ctx.font = `500 ${fontSize}px "${fontFamily}"`

    // First check if it fits on one line
    const singleLineMetrics = ctx.measureText(text)
    if (singleLineMetrics.width <= maxWidth) {
      return { fontSize, lines: [text] }
    }

    // Try wrapping to 2 lines
    const lines = wrapText(ctx, text, maxWidth)
    const lineHeight = fontSize * lineHeightMultiplier
    const totalHeight = lines.length * lineHeight

    // Check if wrapped text fits in available height (max 2 lines)
    if (lines.length <= 2 && totalHeight <= maxHeight) {
      return { fontSize, lines }
    }

    fontSize -= OVERLAY_CONFIG.FONT_SIZE_STEP
  }

  // Fallback: use minimum font size with wrapping
  ctx.font = `500 ${OVERLAY_CONFIG.FONT_SIZE_MIN}px "${fontFamily}"`
  const lines = wrapText(ctx, text, maxWidth)
  console.warn(`Text "${text}" wrapped to ${lines.length} lines at ${OVERLAY_CONFIG.FONT_SIZE_MIN}px`)
  return { fontSize: OVERLAY_CONFIG.FONT_SIZE_MIN, lines: lines.slice(0, 2) } // Max 2 lines
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

    // 4. Use accent color from styleConfig
    const textColor = styleConfig.textColor
    console.log(`Using accent text color: ${textColor}`)

    // 5. Calculate text layout (font size and line wrapping)
    const maxTextWidth = OVERLAY_CONFIG.TEXT_AREA_WIDTH - (OVERLAY_CONFIG.TEXT_PADDING_HORIZONTAL * 2)
    const maxTextHeight = OVERLAY_CONFIG.TEXT_AREA_HEIGHT - (OVERLAY_CONFIG.TEXT_PADDING_VERTICAL * 2)
    const { fontSize, lines } = calculateTextLayout(
      ctx,
      text,
      fontFamilyToUse,
      maxTextWidth,
      maxTextHeight
    )

    // 6. Configure text rendering (use medium weight)
    ctx.font = `500 ${fontSize}px "${fontFamilyToUse}"`
    console.log(`Setting canvas font to: ${ctx.font}`)
    console.log(`Auto-detected text color: ${textColor}`)
    console.log(`Text to render: "${text}" (${lines.length} line${lines.length > 1 ? 's' : ''})`)

    // Test if font is actually working by measuring text
    const testMetrics = ctx.measureText(lines[0])
    console.log(`Text width measurement: ${testMetrics.width}px`)

    if (testMetrics.width === 0) {
      console.warn(`⚠️ Font measurement returned 0, font may not be working. Trying fallback...`)
      ctx.font = `500 ${fontSize}px "${fontFamilyToUse}"`
      const fallbackMetrics = ctx.measureText(lines[0])
      console.log(`Fallback text width: ${fallbackMetrics.width}px`)

      if (fallbackMetrics.width === 0) {
        console.error(`❌ Font completely failed. Using Arial fallback.`)
        ctx.font = `500 ${fontSize}px Arial`
      }
    }

    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'

    // 7. Calculate left-aligned position for text
    const textX = OVERLAY_CONFIG.TEXT_AREA_X + OVERLAY_CONFIG.TEXT_PADDING_HORIZONTAL
    const textAreaCenterY = OVERLAY_CONFIG.TEXT_AREA_Y + (OVERLAY_CONFIG.TEXT_AREA_HEIGHT / 2)
    const lineHeight = fontSize * 1.2

    // Calculate starting Y to center all lines vertically
    const totalTextHeight = lines.length * lineHeight
    const startY = textAreaCenterY - (totalTextHeight / 2) + (lineHeight / 2)

    // 8. Calculate backdrop dimensions based on actual text size
    let maxLineWidth = 0
    for (const line of lines) {
      const metrics = ctx.measureText(line)
      maxLineWidth = Math.max(maxLineWidth, metrics.width)
    }

    const backdropWidth = maxLineWidth + (OVERLAY_CONFIG.BACKDROP_PADDING * 2)
    const backdropHeight = totalTextHeight + (OVERLAY_CONFIG.BACKDROP_PADDING * 2)
    const backdropX = textX - OVERLAY_CONFIG.BACKDROP_PADDING
    const backdropY = textAreaCenterY - (backdropHeight / 2)

    // 9. Draw semi-transparent backdrop using palette secondary color
    const backdropColor = styleConfig.backdropColor || '#404040'
    const backdropOpacity = styleConfig.backdropOpacity || OVERLAY_CONFIG.BACKDROP_OPACITY

    // Convert hex to rgba
    const hexToRgb = (hex) => {
      const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
      return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
      } : { r: 64, g: 64, b: 64 } // Fallback to grey
    }

    const rgb = hexToRgb(backdropColor)
    ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${backdropOpacity})`
    console.log(`Using backdrop color: ${backdropColor} at ${backdropOpacity * 100}% opacity`)

    drawRoundedRect(
      ctx,
      backdropX,
      backdropY,
      backdropWidth,
      backdropHeight,
      OVERLAY_CONFIG.BACKDROP_BORDER_RADIUS
    )
    ctx.fill()

    // 10. Draw text on top of backdrop
    ctx.fillStyle = textColor

    for (let i = 0; i < lines.length; i++) {
      const lineY = startY + (i * lineHeight)
      ctx.fillText(lines[i], textX, lineY)
    }

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
