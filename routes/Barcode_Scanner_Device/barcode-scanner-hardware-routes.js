const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const BarcodeDevice = require('../../models/Barcode_Scanner_Device/BarcodeDevice');
const Firmware = require('../../models/Barcode_Scanner_Device/Firmware');

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const firmwareDir = path.join(__dirname, '../../firmware');
    // Create directory if it doesn't exist
    if (!fs.existsSync(firmwareDir)) {
      fs.mkdirSync(firmwareDir, { recursive: true });
    }
    cb(null, firmwareDir);
  },
  filename: function (req, file, cb) {
    // Get version from request body
    let version = 'unknown';
    
    // Try to get version from different places
    if (req.body.version) {
      version = req.body.version;
    } else if (req.query.version) {
      version = req.query.version;
    }
    
    // Clean the version (remove any special characters)
    version = version.replace(/[^a-zA-Z0-9.]/g, '_');
    
    cb(null, `firmware_v${version}.bin`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    // Accept only .bin files
    if (file.originalname.endsWith('.bin') || file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('Only .bin files are allowed'));
    }
  }
});

// Helper to validate deviceId format (8 char hex)
const isValidDeviceId = (deviceId) => {
  return /^[0-9a-fA-F]{8}$/.test(deviceId);
};

// POST /api/barcode-devices/check-update - Device registration/update check
router.post('/check-update', async (req, res) => {
  try {
    const { deviceId, currentVersion, ipAddress, wifiSSID } = req.body;

    if (!deviceId || !isValidDeviceId(deviceId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid device ID format'
      });
    }

    // Find or create device record
    let device = await BarcodeDevice.findOne({ deviceId });

    if (!device) {
      // New device - store in database
      device = new BarcodeDevice({
        deviceId,
        currentFirmwareVersion: currentVersion || '1.0.0',
        lastIpAddress: ipAddress,
        wifiSSID,
        status: 'online',
        firstSeen: new Date()
      });
    } else {
      // Update existing device
      device.lastSeen = new Date();
      device.lastIpAddress = ipAddress;
      device.wifiSSID = wifiSSID;
      device.status = 'online';
      if (currentVersion) {
        device.currentFirmwareVersion = currentVersion;
      }
    }

    await device.save();

    // Check for firmware updates
    const latestFirmware = await Firmware.findOne({
      isActive: true
    }).sort({ releasedAt: -1 });

    let updateAvailable = false;
    let firmwareInfo = null;

    if (latestFirmware) {
      // Check if this device should get the update
      const shouldUpdate = latestFirmware.targetDevices.includes('all') ||
                          latestFirmware.targetDevices.includes(deviceId);

      if (shouldUpdate && latestFirmware.version !== device.currentFirmwareVersion) {
        updateAvailable = true;
        
        // Generate the firmware URL - FORCE HTTP (ESP32 works better with HTTP)
        const baseUrl = `http://${req.get('host')}`; // Force HTTP, not HTTPS
        firmwareInfo = {
          version: latestFirmware.version,
          url: `${baseUrl}/api/barcode-devices/firmware/download/${latestFirmware.version}`,
          fileSize: latestFirmware.fileSize,
          description: latestFirmware.description
        };
      }
    }

    res.json({
      success: true,
      updateAvailable,
      currentVersion: device.currentFirmwareVersion,
      ...(updateAvailable && { firmware: firmwareInfo })
    });

  } catch (error) {
    console.error('Error in device check-update:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// GET /api/barcode-devices/firmware/download/:version - Download firmware file
router.get('/firmware/download/:version', (req, res) => {
  try {
    const version = req.params.version;
    const firmwarePath = path.join(__dirname, '../../firmware', `firmware_v${version}.bin`);
    
    console.log('Looking for firmware at:', firmwarePath);
    
    // Check if file exists
    if (fs.existsSync(firmwarePath)) {
      // Get file stats
      const stats = fs.statSync(firmwarePath);
      
      // Set headers for binary download
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename=firmware_v${version}.bin`);
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Access-Control-Allow-Origin', '*'); // Allow any origin
      
      // Stream the file
      const fileStream = fs.createReadStream(firmwarePath);
      fileStream.pipe(res);
      
      fileStream.on('error', (error) => {
        console.error('Error streaming firmware:', error);
        res.status(500).json({ success: false, message: 'Error streaming file' });
      });
    } else {
      console.error('Firmware file not found:', firmwarePath);
      res.status(404).json({ success: false, message: 'Firmware not found' });
    }
  } catch (error) {
    console.error('Error downloading firmware:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/barcode-devices - Get all devices (for frontend)
router.get('/', async (req, res) => {
  try {
    const devices = await BarcodeDevice.find({})
      .sort({ lastSeen: -1 })
      .select('deviceId machineId currentFirmwareVersion lastSeen status wifiSSID firstSeen');

    res.json({
      success: true,
      devices
    });
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// GET /api/barcode-devices/:deviceId - Get specific device
router.get('/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;

    if (!isValidDeviceId(deviceId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid device ID format'
      });
    }

    const device = await BarcodeDevice.findOne({ deviceId });

    if (!device) {
      return res.status(404).json({
        success: false,
        message: 'Device not found'
      });
    }

    res.json({
      success: true,
      device
    });
  } catch (error) {
    console.error('Error fetching device:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// POST /api/barcode-devices/firmware - Upload new firmware (from frontend)
router.post('/firmware', upload.single('firmware'), async (req, res) => {
  try {
    const { version, description, targetDevices } = req.body;
    const file = req.file;

    if (!version) {
      return res.status(400).json({
        success: false,
        message: 'Version is required'
      });
    }

    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'Firmware file is required'
      });
    }

    // Get file size
    const fileSize = file.size;

    // Generate the firmware URL - FORCE HTTP (ESP32 works better with HTTP)
    const baseUrl = `http://${req.get('host')}`; // Force HTTP
    const firmwareUrl = `${baseUrl}/api/barcode-devices/firmware/download/${version}`;

    // Deactivate previous versions with same version number
    await Firmware.updateMany(
      { version },
      { isActive: false }
    );

    // Parse targetDevices if it's a string
    let targetDevicesArray = ['all'];
    if (targetDevices) {
      try {
        targetDevicesArray = JSON.parse(targetDevices);
      } catch (e) {
        targetDevicesArray = [targetDevices];
      }
    }

    // Create new firmware record
    const firmware = new Firmware({
      version,
      cloudinaryUrl: firmwareUrl, // Store your server URL here
      fileSize,
      description,
      isActive: true,
      targetDevices: targetDevicesArray,
      releasedAt: new Date()
    });

    await firmware.save();

    res.json({
      success: true,
      message: 'Firmware uploaded successfully',
      firmware: {
        version,
        url: firmwareUrl,
        fileSize,
        description
      }
    });

  } catch (error) {
    console.error('Error saving firmware:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// GET /api/barcode-devices/firmware/list - Get firmware history
router.get('/firmware/list', async (req, res) => {
  try {
    const firmwareList = await Firmware.find({})
      .sort({ releasedAt: -1 })
      .select('version cloudinaryUrl fileSize description releasedAt isActive targetDevices');

    res.json({
      success: true,
      firmwareList
    });
  } catch (error) {
    console.error('Error fetching firmware list:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;