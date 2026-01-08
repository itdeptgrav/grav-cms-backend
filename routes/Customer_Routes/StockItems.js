// routes/Customer_Routes/StockItems.js

const express = require('express');
const router = express.Router();
const StockItem = require('../../models/CMS_Models/Inventory/Products/StockItem');
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

// GET all available stock items for customers
router.get('/available-items', verifyCustomerToken, async (req, res) => {
  try {
    const { search = '', category = '' } = req.query;

    let filter = {
      status: { $in: ['In Stock', 'Low Stock'] }, // Only show items that are available
      productType: 'Goods' // Only show physical goods, not services
    };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { reference: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } }
      ];
    }

    if (category) {
      filter.category = category;
    }

    const stockItems = await StockItem.find(filter)
      .select('name reference category images attributes variants salesPrice quantityOnHand status')
      .sort({ name: 1 })
      .limit(50); // Limit results for performance

    // Format the response
    const formattedItems = stockItems.map(item => ({
      id: item._id,
      name: item.name,
      reference: item.reference,
      category: item.category,
      images: item.images || [],
      attributes: item.attributes || [],
      variants: item.variants.map(variant => ({
        sku: variant.sku,
        attributes: variant.attributes || [],
        quantityOnHand: variant.quantityOnHand,
        salesPrice: variant.salesPrice || item.salesPrice,
        images: variant.images || []
      })),
      baseSalesPrice: item.salesPrice,
      quantityOnHand: item.quantityOnHand,
      status: item.status,
      available: item.quantityOnHand > 0
    }));

    // Get unique categories for filter
    const categories = await StockItem.distinct('category', {
      status: { $in: ['In Stock', 'Low Stock'] },
      productType: 'Goods'
    });

    res.status(200).json({
      success: true,
      items: formattedItems,
      categories: categories.filter(cat => cat).sort(),
      total: formattedItems.length
    });

  } catch (error) {
    console.error('Error fetching stock items:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching available items'
    });
  }
});

// GET specific stock item details
router.get('/available-items/:itemId', verifyCustomerToken, async (req, res) => {
  try {
    const { itemId } = req.params;

    const stockItem = await StockItem.findById(itemId)
      .select('name reference category images attributes variants salesPrice description quantityOnHand status');

    if (!stockItem) {
      return res.status(404).json({
        success: false,
        message: 'Item not found'
      });
    }

    // Check if item is available
    if (stockItem.quantityOnHand === 0) {
      return res.status(400).json({
        success: false,
        message: 'This item is currently out of stock'
      });
    }

    const response = {
      id: stockItem._id,
      name: stockItem.name,
      reference: stockItem.reference,
      category: stockItem.category,
      description: stockItem.description || '',
      images: stockItem.images || [],
      attributes: stockItem.attributes || [],
      variants: stockItem.variants.map(variant => ({
        sku: variant.sku,
        attributes: variant.attributes || [],
        quantityOnHand: variant.quantityOnHand,
        salesPrice: variant.salesPrice || stockItem.salesPrice,
        images: variant.images || []
      })),
      baseSalesPrice: stockItem.salesPrice,
      quantityOnHand: stockItem.quantityOnHand,
      status: stockItem.status,
      available: stockItem.quantityOnHand > 0
    };

    res.status(200).json({
      success: true,
      item: response
    });

  } catch (error) {
    console.error('Error fetching stock item:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching item details'
    });
  }
});

module.exports = router;