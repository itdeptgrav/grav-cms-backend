const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload base64 image to Cloudinary
 */
const uploadBase64Image = async (base64String, options = {}) => {
  try {
    const uploadOptions = {
      folder: options.folder || "employee-documents",
      resource_type: "image",
      ...options,
    };

    const result = await cloudinary.uploader.upload(
      base64String,
      uploadOptions,
    );

    return {
      success: true,
      url: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
      format: result.format,
      bytes: result.bytes,
    };
  } catch (error) {
    console.error("Cloudinary upload error:", error);
    return {
      success: false,
      error: error.message,
    };
  }
};

/**
 * Upload file buffer to Cloudinary
 */
const uploadFileBuffer = async (fileBuffer, options = {}) => {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder: options.folder || "employee-documents",
      resource_type: "auto",
      ...options,
    };

    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve({
            success: true,
            url: result.secure_url,
            publicId: result.public_id,
            width: result.width,
            height: result.height,
            format: result.format,
            bytes: result.bytes,
          });
        }
      },
    );

    streamifier.createReadStream(fileBuffer).pipe(uploadStream);
  });
};

/**
 * Delete image from Cloudinary
 */
const deleteImage = async (publicId) => {
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    return { success: true, result };
  } catch (error) {
    console.error("Cloudinary delete error:", error);
    return { success: false, error: error.message };
  }
};

/**
 * Generate transformed URL for images
 */
const getTransformedUrl = (url, transformations = {}) => {
  if (!url || !url.includes("cloudinary.com")) {
    return url;
  }

  try {
    // Parse the URL to get public_id
    const urlParts = url.split("/");
    const uploadIndex = urlParts.indexOf("upload");

    if (uploadIndex === -1) {
      return url;
    }

    // Build transformation string
    let transformationString = "";
    if (transformations.width || transformations.height) {
      transformationString += `c_fill,w_${transformations.width || 500},h_${transformations.height || 500},`;
    }
    if (transformations.quality) {
      transformationString += `q_${transformations.quality},`;
    }
    if (transformations.gravity) {
      transformationString += `g_${transformations.gravity},`;
    }

    // Remove trailing comma
    if (transformationString.endsWith(",")) {
      transformationString = transformationString.slice(0, -1);
    }

    // Insert transformations into URL
    const newUrlParts = [...urlParts];
    if (transformationString) {
      newUrlParts.splice(uploadIndex + 1, 0, transformationString);
    }

    return newUrlParts.join("/");
  } catch (error) {
    console.error("Error transforming URL:", error);
    return url;
  }
};

module.exports = {
  uploadBase64Image,
  uploadFileBuffer,
  deleteImage,
  getTransformedUrl,
  cloudinary,
};
