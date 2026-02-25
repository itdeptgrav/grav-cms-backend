const express = require('express');
const router = express.Router();
const BarcodeDevice = require('../../models/Barcode_Scanner_Device/BarcodeDevice');
const Firmware = require('../../models/Barcode_Scanner_Device/Firmware');

// Helper to validate deviceId format (24 char hex)
const isValidDeviceId = (deviceId) => {
  return /^[0-9a-fA-F]{8}$/.test(deviceId);
};

// POST /api/barcode-devices/register - Device registration/update check
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
        firmwareInfo = {
          version: latestFirmware.version,
          url: latestFirmware.cloudinaryUrl,
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

// GET /api/barcode-devices - Get all devices (for frontend)
router.get('/', async (req, res) => {
  try {
    const devices = await BarcodeDevice.find({})
      .sort({ lastSeen: -1 })
      .select('deviceId currentFirmwareVersion lastSeen status wifiSSID firstSeen');

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
router.post('/firmware', async (req, res) => {
  try {
    const { version, cloudinaryUrl, cloudinaryPublicId, fileSize, description, targetDevices } = req.body;

    if (!version || !cloudinaryUrl) {
      return res.status(400).json({
        success: false,
        message: 'Version and Cloudinary URL are required'
      });
    }

    // Deactivate previous versions with same version number
    await Firmware.updateMany(
      { version },
      { isActive: false }
    );

    // Create new firmware record
    const firmware = new Firmware({
      version,
      cloudinaryUrl,
      cloudinaryPublicId,
      fileSize,
      description,
      isActive: true,
      targetDevices: targetDevices || ['all'],
      releasedAt: new Date()
    });

    await firmware.save();

    res.json({
      success: true,
      message: 'Firmware uploaded successfully',
      firmware
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