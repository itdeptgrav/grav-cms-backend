// models/Customer_models/Customer.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const customerSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    unique: true,
    trim: true
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters long']
  },
  isPhoneVerified: {
    type: Boolean,
    default: true // Set to true since we verify with OTP
  },
  isEmailVerified: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: {
    type: Date
  },
  profile: {
    avatar: {
      type: String,
      default: null
    },
    address: {
      street: {
        type: String,
        default: null
      },
      city: {
        type: String,
        default: null
      },
      state: {
        type: String,
        default: null
      },
      country: {
        type: String,
        default: 'India'
      },
      pincode: {
        type: String,
        default: null
      },
      landmark: {
        type: String,
        default: null
      }
    },
    measurements: {
      chest: {
        type: Number,
        default: null
      },
      waist: {
        type: Number,
        default: null
      },
      hips: {
        type: Number,
        default: null
      },
      height: {
        type: Number,
        default: null
      },
      shoulder: {
        type: Number,
        default: null
      },
      sleeve: {
        type: Number,
        default: null
      }
    },
    preferences: {
      whatsappNotifications: {
        type: Boolean,
        default: true
      },
      emailNotifications: {
        type: Boolean,
        default: true
      },
      exclusiveAccess: {
        type: Boolean,
        default: true
      }
    }
  },
  orders: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order'
  }],
  cart: [{
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product'
    },
    quantity: {
      type: Number,
      default: 1
    },
    customization: {
      type: Map,
      of: String
    }
  }],
  favorites: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  }]
}, {
  timestamps: true
});


// Method to compare password
customerSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to generate JWT token
customerSchema.methods.generateAuthToken = function() {
  const token = jwt.sign(
    {
      id: this._id,
      phone: this.phone,
      email: this.email,
      name: this.name
    },
    process.env.JWT_SECRET || 'grav_clothing_secret_key_2024',
    {
      expiresIn: process.env.JWT_EXPIRE || '7d'
    }
  );
  return token;
};

// Method to get profile without sensitive data
customerSchema.methods.getProfile = function() {
  const profile = this.toObject();
  delete profile.password;
  delete profile.__v;
  delete profile.cart;
  delete profile.orders;
  delete profile.favorites;
  return profile;
};

module.exports = mongoose.model('Customer', customerSchema);