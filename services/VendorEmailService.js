// services/VendorEmailService.js
const axios = require('axios');

class VendorEmailService {
    constructor() {
        this.apiKey = process.env.BREVO_API_KEY;
        this.senderEmail = "biswalpramod3.1415@gmail.com";
        this.senderName = "Grav Clothing - Purchasing Department";
        this.baseUrl = "https://api.brevo.com/v3";
        this.companyName = "Grav Clothing";
        this.companyAddress = "Mayfair Lagoon Campus";
        this.companyPhone = "+91-9938179834";
        this.companyEmail = "purchasing@grav.in";
    }

    /**
 * Send purchase order email to vendor
 * @param {Object} purchaseOrderData - Purchase order information
 * @param {Object} vendorData - Vendor information
 * @param {Object} senderData - Project manager/sender information
 * @returns {Promise<Object>} - Response from email API
 */
    async sendPurchaseOrderEmail(purchaseOrderData, vendorData, senderData) {
        try {

            const poNumber = purchaseOrderData.poNumber;
            const orderDate = new Date(purchaseOrderData.orderDate).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'long',
                year: 'numeric'
            });
            const expectedDeliveryDate = purchaseOrderData.expectedDeliveryDate ?
                new Date(purchaseOrderData.expectedDeliveryDate).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric'
                }) : 'Not specified';

            // Calculate total items and quantity
            const totalItems = purchaseOrderData.items?.length || 0;
            const totalQuantity = purchaseOrderData.items?.reduce((sum, item) => sum + (item.quantity || 0), 0) || 0;

            // Generate items table
            let itemsTable = '';
            if (purchaseOrderData.items && purchaseOrderData.items.length > 0) {
                purchaseOrderData.items.forEach((item, index) => {
                    itemsTable += `
<tr>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">${index + 1}</td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">${item.itemName || 'N/A'}</td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">${item.sku || 'N/A'}</td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">${item.quantity} ${item.unit || ''}</td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">₹${item.unitPrice?.toFixed(2) || '0.00'}</td>
    <td style="padding: 8px; border-bottom: 1px solid #ddd;">₹${item.totalPrice?.toFixed(2) || '0.00'}</td>
</tr>`;
                });
            }

            const textContent = this.generatePurchaseOrderText(
                vendorData.companyName,
                vendorData.contactPerson,
                poNumber,
                orderDate,
                expectedDeliveryDate,
                purchaseOrderData.items || [],
                totalItems,
                totalQuantity,
                purchaseOrderData.subtotal?.toFixed(2) || '0.00',
                purchaseOrderData.taxRate || 0,
                purchaseOrderData.taxAmount?.toFixed(2) || '0.00',
                purchaseOrderData.shippingCharges?.toFixed(2) || '0.00',
                purchaseOrderData.discount?.toFixed(2) || '0.00',
                purchaseOrderData.totalAmount?.toFixed(2) || '0.00',
                purchaseOrderData.notes || '',
                purchaseOrderData.paymentTerms || '',
                purchaseOrderData.termsConditions || '',
                senderData.name || senderData.email
            );

            const emailPayload = {
                sender: {
                    name: this.senderName,
                    email: this.senderEmail
                },
                to: [
                    {
                        email: vendorData.email,
                        name: vendorData.companyName || vendorData.contactPerson || vendorData.email.split('@')[0]
                    }
                ],
                bcc: [
                    {
                        email: this.companyEmail,
                        name: this.senderName
                    }
                ],
                subject: `Purchase Order ${poNumber} - ${this.companyName}`,
                htmlContent: this.generatePurchaseOrderHTML(
                    vendorData.companyName,
                    vendorData.contactPerson,
                    poNumber,
                    orderDate,
                    expectedDeliveryDate,
                    itemsTable,
                    totalItems,
                    totalQuantity,
                    purchaseOrderData.subtotal?.toFixed(2) || '0.00',
                    purchaseOrderData.taxRate || 0,
                    purchaseOrderData.taxAmount?.toFixed(2) || '0.00',
                    purchaseOrderData.shippingCharges?.toFixed(2) || '0.00',
                    purchaseOrderData.discount?.toFixed(2) || '0.00',
                    purchaseOrderData.totalAmount?.toFixed(2) || '0.00',
                    purchaseOrderData.notes || '',
                    purchaseOrderData.paymentTerms || '',
                    purchaseOrderData.termsConditions || '',
                    senderData.name || senderData.email
                ),
                textContent: textContent,
                headers: {
                    'X-Mailin-custom': 'purchase_order_email'
                }
            };

            const response = await axios.post(
                `${this.baseUrl}/smtp/email`,
                emailPayload,
                {
                    headers: {
                        'api-key': this.apiKey,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    }
                }
            );

            console.log(`Purchase order email sent for ${poNumber}:`, response.data);
            return { success: true, messageId: response.data.messageId };

        } catch (error) {
            console.error('Error sending purchase order email:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.message || error.message
            };
        }
    }

    /**
     * Generate plain text purchase order email with descriptive paragraphs
     */
    generatePurchaseOrderText(companyName, contactPerson, poNumber, orderDate, expectedDeliveryDate, items, totalItems, totalQuantity, subtotal, taxRate, taxAmount, shippingCharges, discount, totalAmount, notes, paymentTerms, termsConditions, preparedBy) {
        let itemsText = '';
        items.forEach((item, index) => {
            itemsText += `
${index + 1}. ${item.itemName} (SKU: ${item.sku || 'N/A'})
   Quantity: ${item.quantity} ${item.unit || ''}
   Unit Price: ₹${item.unitPrice?.toFixed(2) || '0.00'}
   Total: ₹${item.totalPrice?.toFixed(2) || '0.00'}
`;
        });

        return `
PURCHASE ORDER - ${this.companyName}

Dear ${contactPerson ? contactPerson.split(' ')[0] : 'Vendor'},

We are pleased to issue this purchase order for the items required by our manufacturing department. This order consists of ${totalItems} different items with a total quantity of ${totalQuantity} units.

ORDER DETAILS
Purchase Order Number: ${poNumber}
Order Date: ${orderDate}
Expected Delivery Date: ${expectedDeliveryDate}
Prepared By: ${preparedBy}

ORDER SUMMARY
This purchase order contains the following items:

${itemsText}

PRICE BREAKDOWN
Subtotal (before taxes): ₹${subtotal}
${parseFloat(taxAmount) > 0 ? `Tax (${taxRate}%): ₹${taxAmount}` : 'No tax applicable'}
${parseFloat(shippingCharges) > 0 ? `Shipping Charges: ₹${shippingCharges}` : 'Shipping charges included'}
${parseFloat(discount) > 0 ? `Discount Applied: -₹${discount}` : 'No discount applied'}
Grand Total Amount: ₹${totalAmount}

PAYMENT TERMS
${paymentTerms || 'Standard 30 days from invoice date. Payments should be made via bank transfer to the account details that will be provided separately.'}

DELIVERY INSTRUCTIONS
Please ensure that all items are delivered to our facility at the address mentioned below. All deliveries must be accompanied by a delivery note and invoice clearly mentioning this purchase order number. Quality of materials should meet industry standards as specified.

IMPORTANT NOTES
${notes || 'Please ensure proper packaging to prevent damage during transit. All items should be as per the specifications provided.'}

TERMS & CONDITIONS
${termsConditions || 'Standard purchase order terms apply. Goods must be delivered by the expected delivery date. Early deliveries require prior approval. Grav Clothing reserves the right to reject non-conforming goods.'}

ACTION REQUIRED
Please acknowledge receipt of this purchase order and confirm the delivery date at your earliest convenience. This will help us plan our production schedule accordingly.

SHIPPING ADDRESS
${this.companyName}
${this.companyAddress}
Attn: Receiving Department
Contact: ${this.companyPhone}

FOR ANY QUERIES
If you have any questions regarding this order, pricing, or delivery requirements, please contact our purchasing department:

${this.senderName}
Email: ${this.companyEmail}
Phone: ${this.companyPhone}

We appreciate your prompt attention to this order and look forward to a successful business partnership.

Best regards,
${this.senderName}
Purchasing Department
${this.companyName}

---
This purchase order is generated electronically and does not require a physical signature.
© ${new Date().getFullYear()} ${this.companyName}. All rights reserved.
`;
    }

    /**
     * Generate HTML purchase order email with descriptive paragraphs
     */
    generatePurchaseOrderHTML(companyName, contactPerson, poNumber, orderDate, expectedDeliveryDate, itemsTable, totalItems, totalQuantity, subtotal, taxRate, taxAmount, shippingCharges, discount, totalAmount, notes, paymentTerms, termsConditions, preparedBy) {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Purchase Order ${poNumber} - ${this.companyName}</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
        }
        .container {
            background-color: #ffffff;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #007bff;
        }
        .greeting {
            background-color: #f8f9fa;
            padding: 20px;
            border-radius: 5px;
            margin-bottom: 25px;
            border-left: 4px solid #007bff;
        }
        .section {
            margin-bottom: 25px;
            padding: 15px;
            background-color: #f9f9f9;
            border-radius: 5px;
        }
        .section-title {
            color: #007bff;
            font-size: 16px;
            font-weight: bold;
            margin-bottom: 15px;
            padding-bottom: 8px;
            border-bottom: 2px solid #e9ecef;
        }
        .highlight-box {
            background-color: #e7f3ff;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            border: 1px solid #b8daff;
        }
        .details-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-bottom: 20px;
        }
        .detail-item {
            padding: 10px;
            background-color: white;
            border-radius: 4px;
            border: 1px solid #dee2e6;
        }
        .detail-label {
            font-weight: bold;
            color: #495057;
            font-size: 14px;
            margin-bottom: 5px;
        }
        .detail-value {
            color: #212529;
            font-size: 15px;
        }
        .items-table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
            background-color: #fff;
            border: 1px solid #ddd;
        }
        .items-table th {
            background-color: #007bff;
            color: white;
            padding: 12px;
            text-align: left;
            font-weight: bold;
        }
        .items-table td {
            padding: 10px;
            border-bottom: 1px solid #ddd;
        }
        .items-table tr:hover {
            background-color: #f5f5f5;
        }
        .summary-box {
            background-color: #e9ecef;
            padding: 20px;
            border-radius: 5px;
            margin: 20px 0;
        }
        .summary-line {
            display: flex;
            justify-content: space-between;
            margin: 8px 0;
            padding: 5px 0;
            border-bottom: 1px dashed #6c757d;
        }
        .total-amount {
            background-color: #28a745;
            color: white;
            padding: 15px;
            border-radius: 5px;
            text-align: center;
            font-size: 20px;
            font-weight: bold;
            margin: 20px 0;
        }
        .notes-section {
            background-color: #fff3cd;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            border-left: 4px solid #ffc107;
        }
        .terms-section {
            background-color: #f8f9fa;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            border: 1px solid #dee2e6;
        }
        .action-section {
            background-color: #d4edda;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            text-align: center;
            border: 1px solid #c3e6cb;
        }
        .contact-info {
            background-color: #e7f3ff;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
        }
        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            text-align: center;
            color: #666;
            font-size: 12px;
        }
        .paragraph {
            margin-bottom: 15px;
            line-height: 1.6;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1 style="margin: 0; color: #007bff;">PURCHASE ORDER</h1>
            <p style="margin: 5px 0; color: #666;">${this.companyName} - Purchasing Department</p>
            <p style="margin: 5px 0; color: #666;">${this.companyAddress}</p>
        </div>

        <div class="greeting">
            <h3 style="margin-top: 0; color: #007bff;">Dear ${contactPerson ? contactPerson.split(' ')[0] : 'Vendor'},</h3>
            <p class="paragraph">We are pleased to issue this purchase order for the items required by our manufacturing department. This order consists of <strong>${totalItems} different items</strong> with a total quantity of <strong>${totalQuantity} units</strong>.</p>
            <p class="paragraph">Please find below the complete details of your order. We request you to review the information carefully and acknowledge receipt at your earliest convenience.</p>
        </div>

        <div class="section">
            <h3 class="section-title">📋 Order Overview</h3>
            <div class="details-grid">
                <div class="detail-item">
                    <div class="detail-label">Purchase Order Number</div>
                    <div class="detail-value" style="color: #007bff; font-size: 18px; font-weight: bold;">${poNumber}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-label">Order Date</div>
                    <div class="detail-value">${orderDate}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-label">Expected Delivery</div>
                    <div class="detail-value">${expectedDeliveryDate}</div>
                </div>
                <div class="detail-item">
                    <div class="detail-label">Prepared By</div>
                    <div class="detail-value">${preparedBy}</div>
                </div>
            </div>
        </div>

        <div class="section">
            <h3 class="section-title">📦 Items Ordered</h3>
            <p class="paragraph">The following items have been ordered for our production requirements:</p>
            <table class="items-table">
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Item Description</th>
                        <th>SKU</th>
                        <th>Quantity</th>
                        <th>Unit Price</th>
                        <th>Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${itemsTable}
                </tbody>
            </table>
        </div>

        <div class="section">
            <h3 class="section-title">💰 Price Summary</h3>
            <div class="summary-box">
                <div class="summary-line">
                    <span>Subtotal (before taxes):</span>
                    <span>₹${subtotal}</span>
                </div>
                ${parseFloat(taxAmount) > 0 ? `
                <div class="summary-line">
                    <span>Tax (${taxRate}%):</span>
                    <span>₹${taxAmount}</span>
                </div>
                ` : ''}
                ${parseFloat(shippingCharges) > 0 ? `
                <div class="summary-line">
                    <span>Shipping Charges:</span>
                    <span>₹${shippingCharges}</span>
                </div>
                ` : ''}
                ${parseFloat(discount) > 0 ? `
                <div class="summary-line">
                    <span>Discount Applied:</span>
                    <span style="color: #dc3545;">-₹${discount}</span>
                </div>
                ` : ''}
                <div class="total-amount">
                    Grand Total: ₹${totalAmount}
                </div>
            </div>
        </div>

        <div class="section">
            <h3 class="section-title">💳 Payment Information</h3>
            <p class="paragraph"><strong>Payment Terms:</strong> ${paymentTerms || 'Standard 30 days from invoice date. Payments should be made via bank transfer to the account details that will be provided separately.'}</p>
            <p class="paragraph">Please ensure all invoices reference this purchase order number (${poNumber}) for proper processing and payment.</p>
        </div>

        ${notes ? `
        <div class="notes-section">
            <h3 class="section-title" style="color: #856404;">📝 Special Instructions</h3>
            <p class="paragraph">${notes}</p>
        </div>
        ` : ''}

        <div class="section">
            <h3 class="section-title">🚚 Delivery Instructions</h3>
            <p class="paragraph">Please ensure that all items are delivered to our facility at the address mentioned below. All deliveries must be accompanied by a delivery note and invoice clearly mentioning this purchase order number.</p>
            <div class="highlight-box">
                <h4 style="margin-top: 0; color: #0056b3;">Shipping Address:</h4>
                <p><strong>${this.companyName}</strong><br>
                ${this.companyAddress}<br>
                <strong>Attn:</strong> Receiving Department<br>
                <strong>Contact:</strong> ${this.companyPhone}</p>
            </div>
            <p class="paragraph">Quality of materials should meet industry standards as specified. Proper packaging is required to prevent damage during transit.</p>
        </div>

        <div class="action-section">
            <h3 style="margin-top: 0; color: #155724;">⚠️ ACTION REQUIRED</h3>
            <p class="paragraph"><strong>Please acknowledge receipt of this purchase order and confirm the delivery date.</strong> This will help us plan our production schedule accordingly and ensure timely processing of your payment.</p>
        </div>

        <div class="contact-info">
            <h3 class="section-title">📞 Contact Information</h3>
            <p class="paragraph">If you have any questions regarding this order, pricing, or delivery requirements, please contact our purchasing department:</p>
            <p><strong>${this.senderName}</strong><br>
            <strong>Email:</strong> <a href="mailto:${this.companyEmail}">${this.companyEmail}</a><br>
            <strong>Phone:</strong> ${this.companyPhone}</p>
        </div>

        ${termsConditions ? `
        <div class="terms-section">
            <h3 class="section-title">📄 Terms & Conditions</h3>
            <p class="paragraph">${termsConditions}</p>
        </div>
        ` : ''}

        <div style="margin: 30px 0; text-align: center; padding: 20px; background-color: #f8f9fa; border-radius: 5px;">
            <p class="paragraph">We appreciate your prompt attention to this order and look forward to a successful business partnership.</p>
            <p style="font-size: 16px; font-weight: bold; color: #333;">Thank you for your business!</p>
        </div>

        <div style="margin-top: 40px; padding-top: 20px; border-top: 2px solid #007bff;">
            <p>Best regards,</p>
            <p><strong>${this.senderName}</strong><br>
            Purchasing Department<br>
            ${this.companyName}</p>
        </div>

        <div class="footer">
            <p>This purchase order is generated electronically and does not require a physical signature.</p>
            <p>© ${new Date().getFullYear()} ${this.companyName}. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
    }

    /**
     * Send delivery acknowledgement request email
     * @param {Object} purchaseOrderData - Purchase order information
     * @param {Object} vendorData - Vendor information
     * @param {Object} deliveryData - Delivery information
     * @returns {Promise<Object>} - Response from email API
     */
    async sendDeliveryAcknowledgementEmail(purchaseOrderData, vendorData, deliveryData) {
        try {
            const textContent = this.generateDeliveryAcknowledgementText(
                vendorData.companyName,
                purchaseOrderData.poNumber,
                deliveryData.quantityReceived,
                deliveryData.deliveryDate,
                deliveryData.invoiceNumber,
                deliveryData.notes
            );

            const emailPayload = {
                sender: {
                    name: this.senderName,
                    email: this.senderEmail
                },
                to: [
                    {
                        email: vendorData.email,
                        name: vendorData.companyName || vendorData.contactPerson
                    }
                ],
                subject: `Delivery Acknowledgement - PO ${purchaseOrderData.poNumber} - ${this.companyName}`,
                htmlContent: this.generateDeliveryAcknowledgementHTML(
                    vendorData.companyName,
                    purchaseOrderData.poNumber,
                    deliveryData.quantityReceived,
                    deliveryData.deliveryDate,
                    deliveryData.invoiceNumber,
                    deliveryData.notes
                ),
                textContent: textContent,
                headers: {
                    'X-Mailin-custom': 'delivery_acknowledgement_email'
                }
            };

            const response = await axios.post(
                `${this.baseUrl}/smtp/email`,
                emailPayload,
                {
                    headers: {
                        'api-key': this.apiKey,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    }
                }
            );

            console.log(`Delivery acknowledgement email sent for PO ${purchaseOrderData.poNumber}:`, response.data);
            return { success: true, messageId: response.data.messageId };

        } catch (error) {
            console.error('Error sending delivery acknowledgement email:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.message || error.message
            };
        }
    }

    /**
     * Generate plain text delivery acknowledgement email
     */
    generateDeliveryAcknowledgementText(companyName, poNumber, quantityReceived, deliveryDate, invoiceNumber, notes) {
        return `
DELIVERY ACKNOWLEDGEMENT - ${this.companyName}

To: ${companyName}

Delivery Details:
Purchase Order: ${poNumber}
Quantity Received: ${quantityReceived}
Delivery Date: ${new Date(deliveryDate).toLocaleDateString('en-IN')}
Invoice Number: ${invoiceNumber || 'Not provided'}

Notes: ${notes || 'No additional notes'}

This email confirms that we have received the above delivery against your invoice.

Please ensure the remaining items (if any) are delivered as per the agreed schedule.

If you have any questions regarding this delivery, please contact:
${this.senderName}
Email: ${this.companyEmail}
Phone: ${this.companyPhone}

Thank you for your service.

Best regards,
${this.senderName}
${this.companyName}

---
This is an automated acknowledgement.
© ${new Date().getFullYear()} ${this.companyName}. All rights reserved.
`;
    }

    /**
     * Generate HTML delivery acknowledgement email
     */
    generateDeliveryAcknowledgementHTML(companyName, poNumber, quantityReceived, deliveryDate, invoiceNumber, notes) {
        const formattedDate = new Date(deliveryDate).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });

        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Delivery Acknowledgement - ${this.companyName}</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .container {
            background-color: #ffffff;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 2px solid #28a745;
        }
        .details-box {
            background-color: #d4edda;
            padding: 15px;
            border-radius: 5px;
            margin: 20px 0;
            border: 1px solid #c3e6cb;
        }
        .detail-item {
            margin: 10px 0;
            padding: 8px 0;
            border-bottom: 1px dashed #a3d9a5;
        }
        .detail-item:last-child {
            border-bottom: none;
        }
        .detail-label {
            font-weight: bold;
            color: #155724;
        }
        .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            text-align: center;
            color: #666;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h2 style="margin: 0; color: #28a745;">DELIVERY ACKNOWLEDGEMENT</h2>
            <p style="margin: 5px 0; color: #666;">${this.companyName}</p>
        </div>

        <p>To: <strong>${companyName}</strong></p>

        <div class="details-box">
            <h3 style="margin-top: 0; color: #155724;">Delivery Received</h3>
            <div class="detail-item">
                <span class="detail-label">Purchase Order:</span> ${poNumber}
            </div>
            <div class="detail-item">
                <span class="detail-label">Quantity Received:</span> ${quantityReceived}
            </div>
            <div class="detail-item">
                <span class="detail-label">Delivery Date:</span> ${formattedDate}
            </div>
            ${invoiceNumber ? `
            <div class="detail-item">
                <span class="detail-label">Invoice Number:</span> ${invoiceNumber}
            </div>
            ` : ''}
            ${notes ? `
            <div class="detail-item">
                <span class="detail-label">Notes:</span> ${notes}
            </div>
            ` : ''}
        </div>

        <p>This email confirms that we have received the above delivery against your invoice.</p>
        <p>Please ensure the remaining items (if any) are delivered as per the agreed schedule.</p>

        <p>If you have any questions regarding this delivery, please contact:</p>
        <p><strong>${this.senderName}</strong><br>
        Email: <a href="mailto:${this.companyEmail}">${this.companyEmail}</a><br>
        Phone: ${this.companyPhone}</p>

        <p>Thank you for your service.</p>

        <div style="margin-top: 30px;">
            <p>Best regards,<br>
            <strong>${this.senderName}</strong><br>
            ${this.companyName}</p>
        </div>

        <div class="footer">
            <p>This is an automated acknowledgement.</p>
            <p>© ${new Date().getFullYear()} ${this.companyName}. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
    }
}

module.exports = new VendorEmailService();


