// routes/CustomerProfile_Routes.js
const express = require('express');
const router = express.Router();
const Customer = require('../../models/Customer_Models/Customer');
const jwt = require('jsonwebtoken');

// Middleware to verify customer token
const verifyCustomerToken = async (req, res, next) => {
  try {
    const token = req.cookies.customerToken;
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Please sign in.'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'grav_clothing_secret_key_2024');
    req.customerId = decoded.id;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token. Please sign in again.'
    });
  }
};

// Get customer profile
router.get('/', verifyCustomerToken, async (req, res) => {
  try {
    const customerId = req.customerId;
    
    const customer = await Customer.findById(customerId)
      .select('-password -__v -cart -orders -favorites');

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    // Check if address is complete
    const hasCompleteAddress = customer.profile.address.street && 
                              customer.profile.address.city && 
                              customer.profile.address.pincode;

    res.status(200).json({
      success: true,
      customer: customer.toObject(),
      hasCompleteAddress
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update customer profile
router.put('/', verifyCustomerToken, async (req, res) => {
  try {
    const customerId = req.customerId;
    const updates = req.body;

    // Find customer
    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    // Don't allow updating email, phone, or password through this route
    delete updates.email;
    delete updates.phone;
    delete updates.password;

    // Update basic info
    if (updates.name) customer.name = updates.name;

    // Update profile fields
    if (updates.profile) {
      if (updates.profile.address) {
        customer.profile.address = {
          ...customer.profile.address,
          ...updates.profile.address
        };
      }
      if (updates.profile.measurements) {
        customer.profile.measurements = {
          ...customer.profile.measurements,
          ...updates.profile.measurements
        };
      }
      if (updates.profile.preferences) {
        customer.profile.preferences = {
          ...customer.profile.preferences,
          ...updates.profile.preferences
        };
      }
    }

    await customer.save();

    const updatedCustomer = await Customer.findById(customerId)
      .select('-password -__v -cart -orders -favorites');

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      customer: updatedCustomer
    });

  } catch (error) {
    console.error('Update profile error:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update only address
router.put('/address', verifyCustomerToken, async (req, res) => {
  try {
    const customerId = req.customerId;
    const addressData = req.body;

    // Validate required fields
    if (!addressData.street || !addressData.city || !addressData.pincode) {
      return res.status(400).json({
        success: false,
        message: 'Street, city, and pincode are required'
      });
    }

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    // Update address
    customer.profile.address = {
      ...customer.profile.address,
      ...addressData,
      country: addressData.country || 'India'
    };

    await customer.save();

    res.status(200).json({
      success: true,
      message: 'Address updated successfully',
      address: customer.profile.address
    });

  } catch (error) {
    console.error('Update address error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update preferences
router.put('/preferences', verifyCustomerToken, async (req, res) => {
  try {
    const customerId = req.customerId;
    const preferences = req.body;

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    // Update preferences
    customer.profile.preferences = {
      ...customer.profile.preferences,
      ...preferences
    };

    await customer.save();

    res.status(200).json({
      success: true,
      message: 'Preferences updated successfully',
      preferences: customer.profile.preferences
    });

  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update measurements
router.put('/measurements', verifyCustomerToken, async (req, res) => {
  try {
    const customerId = req.customerId;
    const measurements = req.body;

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    // Update measurements
    customer.profile.measurements = {
      ...customer.profile.measurements,
      ...measurements
    };

    await customer.save();

    res.status(200).json({
      success: true,
      message: 'Measurements updated successfully',
      measurements: customer.profile.measurements
    });

  } catch (error) {
    console.error('Update measurements error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update email (requires verification)
router.put('/email', verifyCustomerToken, async (req, res) => {
  try {
    const customerId = req.customerId;
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Check if email already exists
    const existingCustomer = await Customer.findOne({ 
      email: email.toLowerCase(),
      _id: { $ne: customerId }
    });

    if (existingCustomer) {
      return res.status(400).json({
        success: false,
        message: 'Email already in use'
      });
    }

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    // Update email and reset verification
    customer.email = email.toLowerCase();
    customer.isEmailVerified = false;

    await customer.save();

    res.status(200).json({
      success: true,
      message: 'Email updated successfully. Please verify your new email.',
      email: customer.email
    });

  } catch (error) {
    console.error('Update email error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Change password
router.put('/password', verifyCustomerToken, async (req, res) => {
  try {
    const customerId = req.customerId;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 8 characters long'
      });
    }

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    // Verify current password
    const isPasswordValid = await customer.comparePassword(currentPassword);
    if (!isPasswordValid) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Update password
    customer.password = newPassword;
    await customer.save();

    res.status(200).json({
      success: true,
      message: 'Password updated successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;