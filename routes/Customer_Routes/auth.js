// routes/Customer_Routes.js
const express = require('express');
const router = express.Router();
const Customer = require('../../models/Customer_Models/Customer');
const jwt = require('jsonwebtoken');
const CustomerEmailService = require('../../services/CustomerEmailService');

// Check if phone exists
router.post('/check-phone', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required'
      });
    }

    const formattedPhone = phone.startsWith('+91') ? phone : `+91${phone}`;
    
    const customer = await Customer.findOne({ phone: formattedPhone });

    res.status(200).json({
      success: true,
      exists: !!customer,
      message: customer ? 'Phone number already registered' : 'Phone number available'
    });

  } catch (error) {
    console.error('Check phone error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

// Check authentication status (for auto signin)
router.get('/check-auth', async (req, res) => {
  try {
    const token = req.cookies.customerToken;

    if (!token) {
      return res.status(200).json({
        success: false,
        isAuthenticated: false,
        message: 'No authentication token found'
      });
    }

    // Verify token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'grav_clothing_secret_key_2024'
    );

    // Find customer
    const customer = await Customer.findById(decoded.id);

    if (!customer) {
      return res.status(200).json({
        success: false,
        isAuthenticated: false,
        message: 'Customer not found'
      });
    }

    // Return customer data without sensitive info
    const customerResponse = customer.toObject();
    delete customerResponse.__v;

    res.status(200).json({
      success: true,
      isAuthenticated: true,
      customer: customerResponse,
      message: 'User is authenticated'
    });

  } catch (error) {
    console.error('Auth check error:', error);
    res.status(200).json({
      success: false,
      isAuthenticated: false,
      message: 'Authentication failed'
    });
  }
});

// Customer Signup
router.post('/signup', async (req, res) => {
  try {
    const { name, email, phone } = req.body;

    // Validate required fields
    if (!name || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Name, email and phone are required'
      });
    }

    // Format phone number
    const formattedPhone = phone.startsWith('+91') ? phone : `+91${phone}`;

    // Check if customer already exists
    const existingCustomer = await Customer.findOne({ 
      $or: [{ email: email.toLowerCase() }, { phone: formattedPhone }] 
    });

    if (existingCustomer) {
      return res.status(400).json({
        success: false,
        message: 'Customer with this email or phone already exists'
      });
    }

    // Create new customer
    const customer = new Customer({
      name,
      email: email.toLowerCase(),
      phone: formattedPhone,
      isPhoneVerified: true
    });

    await customer.save();

    // Generate token
    const token = customer.generateAuthToken();

    // Set token in cookie
    res.cookie('customerToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'none',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    // Update last login
    customer.lastLogin = Date.now();
    await customer.save();

    // Send welcome email (don't await, send in background)
    try {
      CustomerEmailService.sendWelcomeEmail({
        name: customer.name,
        email: customer.email,
        phone: customer.phone
      }).then(result => {
        if (result.success) {
          console.log(`Welcome email sent successfully to ${customer.email}`);
        } else {
          console.warn(`Failed to send welcome email to ${customer.email}:`, result.error);
        }
      }).catch(emailError => {
        console.error(`Error in email sending for ${customer.email}:`, emailError);
      });
    } catch (emailError) {
      // Don't let email failure affect signup
      console.error('Email sending failed:', emailError);
    }

    // Remove sensitive data from response
    const customerResponse = customer.toObject();
    delete customerResponse.__v;

    res.status(201).json({
      success: true,
      message: 'Account created successfully. Welcome email has been sent.',
      customer: customerResponse
    });

  } catch (error) {
    console.error('Signup error:', error);
    
    // Handle duplicate key errors
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Email or phone number already exists'
      });
    }

    // Handle validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ')
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error during signup',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Customer Signin
router.post('/signin', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required'
      });
    }

    // Format phone number
    const formattedPhone = phone.startsWith('+91') ? phone : `+91${phone}`;

    // Find customer by phone
    const customer = await Customer.findOne({ phone: formattedPhone });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found. Please sign up first.'
      });
    }

    // Generate token
    const token = customer.generateAuthToken();

    // Set token in cookie
    res.cookie('customerToken', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? "none" : "lax", 
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    // Update last login
    customer.lastLogin = Date.now();
    await customer.save();

    // Remove sensitive data from response
    const customerResponse = customer.toObject();
    delete customerResponse.__v;

    res.status(200).json({
      success: true,
      message: 'Sign in successful',
      customer: customerResponse
    });

  } catch (error) {
    console.error('Signin error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during signin',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Sign out
router.post('/signout', (req, res) => {
  res.clearCookie('customerToken');
  res.status(200).json({
    success: true,
    message: 'Signed out successfully'
  });
});

module.exports = router;