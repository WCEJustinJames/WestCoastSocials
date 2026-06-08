/**
 * Read a picked image file into base64 (no `data:` prefix), for storing on a
 * draft/batch row. The local sender decodes it and uploads to Beeper.
 */
export interface PickedImage {
  dataBase64: string
  name: string
  mime: string
}

const MAX_BYTES = 8 * 1024 * 1024 // 8 MB — keeps DB rows sane; MMS/most networks cap well below this.

export async function fileToBase64(file: File): Promise<PickedImage> {
  if (file.size > MAX_BYTES) {
    throw new Error(`Image is ${(file.size / 1e6).toFixed(1)}MB — max 8MB.`)
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Could not read file'))
    reader.readAsDataURL(file)
  })
  const comma = dataUrl.indexOf(',')
  return {
    dataBase64: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
    name: file.name,
    mime: file.type || 'application/octet-stream',
  }
}
