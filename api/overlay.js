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
  // Text area for sampling dominant color
  TEXT_AREA_X: 51,
  TEXT_AREA_Y: 60,
  TEXT_AREA_WIDTH: 922,
  TEXT_AREA_HEIGHT: 280,
  TEXT_PADDING_HORIZONTAL: 30,
  TEXT_PADDING_VERTICAL: 20,
  FONT_SIZE_MAX: 120,
  FONT_SIZE_MIN: 80,
  FONT_SIZE_STEP: 2,
  // Backdrop settings for text readability
  BACKDROP_OPACITY: 0.6,
  BACKDROP_PADDING: 20,
  BACKDROP_BORDER_RADIUS: 12
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
 * Extract dominant color from a region of the image
 * Uses color bucketing for performance
 * Returns { r, g, b } of the most common color
 */
function extractDominantColor(ctx, x, y, width, height) {
  const imageData = ctx.getImageData(x, y, width, height)
  const data = imageData.data
  const colorBuckets = {}

  // Sample every 10th pixel for performance
  for (let i = 0; i < data.length; i += 40) { // 4 channels * 10 = 40
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]

    // Reduce to 32 color buckets per channel (8 levels each)
    const bucketR = Math.floor(r / 32) * 32
    const bucketG = Math.floor(g / 32) * 32
    const bucketB = Math.floor(b / 32) * 32

    const key = `${bucketR},${bucketG},${bucketB}`
    colorBuckets[key] = (colorBuckets[key] || 0) + 1
  }

  // Find most common color bucket
  let maxCount = 0
  let dominantKey = '128,128,128'

  for (const [key, count] of Object.entries(colorBuckets)) {
    if (count > maxCount) {
      maxCount = count
      dominantKey = key
    }
  }

  const [r, g, b] = dominantKey.split(',').map(Number)
  return { r, g, b }
}

/**
 * Calculate relative luminance (WCAG formula)
 */
function calculateLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map(c => {
    c = c / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
}

/**
 * Calculate contrast ratio between two colors
 */
function getContrastRatio(r1, g1, b1, r2, g2, b2) {
  const lum1 = calculateLuminance(r1, g1, b1)
  const lum2 = calculateLuminance(r2, g2, b2)
  const lighter = Math.max(lum1, lum2)
  const darker = Math.min(lum1, lum2)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Get a contrasting color for text based on dominant background color
 * Returns hex color string
 */
function getContrastingTextColor(dominantColor) {
  const { r, g, b } = dominantColor

  // Check contrast with white and black
  const whiteContrast = getContrastRatio(r, g, b, 255, 255, 255)
  const blackContrast = getContrastRatio(r, g, b, 0, 0, 0)

  // Use whichever has better contrast (minimum 4.5:1 for WCAG AA)
  if (whiteContrast >= blackContrast && whiteContrast >= 4.5) {
    return '#FFFFFF'
  } else if (blackContrast >= 4.5) {
    return '#000000'
  }

  // If neither meets 4.5:1, use the better one
  return whiteContrast >= blackContrast ? '#FFFFFF' : '#000000'
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
    ctx.font = `bold ${fontSize}px "${fontFamily}"`

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
  ctx.font = `bold ${OVERLAY_CONFIG.FONT_SIZE_MIN}px "${fontFamily}"`
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

    // 4. Extract dominant color from text area and calculate contrasting text color
    const dominantColor = extractDominantColor(
      ctx,
      OVERLAY_CONFIG.TEXT_AREA_X,
      OVERLAY_CONFIG.TEXT_AREA_Y,
      OVERLAY_CONFIG.TEXT_AREA_WIDTH,
      OVERLAY_CONFIG.TEXT_AREA_HEIGHT
    )
    console.log(`Dominant background color: rgb(${dominantColor.r}, ${dominantColor.g}, ${dominantColor.b})`)

    // Get contrasting text color based on dominant background
    const textColor = getContrastingTextColor(dominantColor)
    console.log(`Calculated contrasting text color: ${textColor}`)

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

    // 6. Configure text rendering
    const fontWeight = hasStyles ? '700' : 'bold'
    ctx.font = `${fontWeight} ${fontSize}px "${fontFamilyToUse}"`
    console.log(`Setting canvas font to: ${ctx.font}`)
    console.log(`Auto-detected text color: ${textColor}`)
    console.log(`Text to render: "${text}" (${lines.length} line${lines.length > 1 ? 's' : ''})`)

    // Test if font is actually working by measuring text
    const testMetrics = ctx.measureText(lines[0])
    console.log(`Text width measurement: ${testMetrics.width}px`)

    if (testMetrics.width === 0) {
      console.warn(`⚠️ Font measurement returned 0, font may not be working. Trying fallback...`)
      ctx.font = `${fontSize}px "${fontFamilyToUse}"`
      const fallbackMetrics = ctx.measureText(lines[0])
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
    const backdropX = textX - (backdropWidth / 2)
    const backdropY = textAreaCenterY - (backdropHeight / 2)

    // 9. Draw semi-transparent backdrop (opposite of text color for contrast)
    const backdropColor = textColor === '#FFFFFF' ? '0, 0, 0' : '255, 255, 255'
    ctx.fillStyle = `rgba(${backdropColor}, ${OVERLAY_CONFIG.BACKDROP_OPACITY})`
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
