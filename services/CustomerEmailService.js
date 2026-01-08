// /services/CustomerEmailService.js
const axios = require('axios');

class CustomerEmailService {
    constructor() {
        this.apiKey = process.env.BREVO_API_KEY;
        this.senderEmail = "biswalpramod3.1415@gmail.com";
        this.senderName = "Grav Clothing";
        this.baseUrl = "https://api.brevo.com/v3";
        this.websiteUrl = process.env.WEBSITE_URL || "https://grav.in";
    }

    /**
     * Send welcome email to new customer
     * @param {Object} customerData - Customer information
     * @param {string} customerData.email - Customer email
     * @param {string} customerData.name - Customer name
     * @param {string} customerData.phone - Customer phone
     * @returns {Promise<Object>} - Response from email API
     */
    async sendWelcomeEmail(customerData) {
        try {
            const dashboardUrl = `${this.websiteUrl}/dashboard`;

            // Simple plain text email template
            const textContent = this.generateWelcomeEmailText(
                customerData.name,
                customerData.email,
                dashboardUrl
            );

            const emailPayload = {
                sender: {
                    name: this.senderName,
                    email: this.senderEmail
                },
                to: [
                    {
                        email: customerData.email,
                        name: customerData.name || customerData.email.split('@')[0]
                    }
                ],
                subject: `Welcome to Grav Clothing - Your Account is Ready`,
                htmlContent: this.generateWelcomeEmailHTML(
                    customerData.name,
                    customerData.email,
                    dashboardUrl
                ),
                textContent: textContent,
                headers: {
                    'X-Mailin-custom': 'customer_welcome_email'
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

            console.log(`Welcome email sent to ${customerData.email}:`, response.data);
            return { success: true, messageId: response.data.messageId };

        } catch (error) {
            console.error('Error sending welcome email:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.message || error.message
            };
        }
    }

    /**
     * Send request confirmation email to customer
     * @param {Object} requestData - Request information
     * @param {Object} customerData - Customer information
     * @returns {Promise<Object>} - Response from email API
     */
    async sendRequestConfirmationEmail(requestData, customerData) {
        try {
            const dashboardUrl = `${this.websiteUrl}/dashboard/my-requests`;
            const requestId = requestData.requestId;
            const requestDate = new Date(requestData.createdAt).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'long',
                year: 'numeric'
            });

            // Generate summary of clothing items
            let itemSummary = '';
            let totalItems = 0;

            if (requestData.clothCategories && requestData.clothCategories.length > 0) {
                requestData.clothCategories.forEach(category => {
                    category.items.forEach(item => {
                        totalItems += item.quantity || 0;
                        itemSummary += `\n- ${item.quantity}x ${item.color} ${category.categoryName} (Size: ${item.size})`;
                    });
                });
            }

            const textContent = this.generateRequestConfirmationText(
                customerData.name,
                requestId,
                requestDate,
                itemSummary,
                totalItems,
                dashboardUrl
            );

            const emailPayload = {
                sender: {
                    name: this.senderName,
                    email: this.senderEmail
                },
                to: [
                    {
                        email: customerData.email,
                        name: customerData.name || customerData.email.split('@')[0]
                    }
                ],
                subject: `Grav Clothing - Request Confirmation (${requestId})`,
                htmlContent: this.generateRequestConfirmationHTML(
                    customerData.name,
                    requestId,
                    requestDate,
                    itemSummary,
                    totalItems,
                    dashboardUrl
                ),
                textContent: textContent,
                headers: {
                    'X-Mailin-custom': 'request_confirmation_email'
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

            console.log(`Request confirmation email sent for ${requestId}:`, response.data);
            return { success: true, messageId: response.data.messageId };

        } catch (error) {
            console.error('Error sending request confirmation email:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.message || error.message
            };
        }
    }

    /**
     * Generate plain text welcome email
     */
    generateWelcomeEmailText(name, email, dashboardUrl) {
        const currentDate = new Date().toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });

        return `
Welcome to Grav Clothing

Dear ${name},

Thank you for creating an account with Grav Clothing. We're excited to have you join our community of style enthusiasts.

Your account has been successfully created with the following details:

Name: ${name}
Email: ${email}
Account Created: ${currentDate}

You can now access your dashboard to:
- Submit custom clothing requests
- Track your orders
- Manage your profile
- View your measurements
- Save your favorite styles

Access your dashboard here: ${dashboardUrl}

At Grav Clothing, we believe in creating clothing that reflects your personal style and fits you perfectly. Our expert tailors are ready to bring your vision to life.

For any assistance or queries, please feel free to contact us at support@grav.in or call us at +91-XXXXXXXXXX.

Thank you for choosing Grav Clothing. We look forward to creating something special for you.

Best regards,
Grav Clothing Team
Mayfair Lagoon Campus
Est. 2024

---
This is an automated message. Please do not reply to this email.
For support, email: support@grav.in
© ${new Date().getFullYear()} Grav Clothing. All rights reserved.
`;
    }

    /**
     * Generate plain text request confirmation email
     */
    generateRequestConfirmationText(name, requestId, requestDate, itemSummary, totalItems, dashboardUrl) {
        return `
Grav Clothing - Request Confirmation

Dear ${name},

Thank you for submitting your clothing request. We have received your order details and our team is now reviewing your requirements.

Request Details:
Request ID: ${requestId}
Date Submitted: ${requestDate}
Total Items: ${totalItems}

Items Requested:${itemSummary}

Your request is currently in "Pending" status. Our tailoring team will review your requirements and contact you if any clarifications are needed.

Next Steps:
1. Our team reviews your request (1-2 business days)
2. We'll contact you for any clarifications if needed
3. Once approved, we'll begin working on your order
4. You'll receive updates on your dashboard

You can track the status of your request here: ${dashboardUrl}

If you need to make any changes to your request or have any questions, please contact us at support@grav.in or call us at +91-XXXXXXXXXX.

Please quote your Request ID (${requestId}) in all communications for faster service.

Thank you for choosing Grav Clothing. We look forward to creating your bespoke clothing.

Best regards,
Grav Clothing Team
Tailoring Department
Mayfair Lagoon Campus
Est. 2024

---
This is an automated message. Please do not reply to this email.
For support, email: support@grav.in
© ${new Date().getFullYear()} Grav Clothing. All rights reserved.
`;
    }

    /**
     * Generate HTML welcome email (simple and formal)
     */
    generateWelcomeEmailHTML(name, email, dashboardUrl) {
        const currentDate = new Date().toLocaleDateString('en-IN', {
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
    <title>Welcome to Grav Clothing</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .content {
            background-color: #ffffff;
            padding: 20px;
        }
        .greeting {
            font-size: 16px;
            margin-bottom: 20px;
        }
        .details {
            margin: 20px 0;
            padding: 15px;
            background-color: #f9f9f9;
            border-left: 4px solid #333;
        }
        .detail-item {
            margin: 10px 0;
        }
        .dashboard-link {
            display: inline-block;
            background-color: #333;
            color: white;
            padding: 10px 20px;
            text-decoration: none;
            margin: 15px 0;
        }
        .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            font-size: 12px;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="content">
        <div class="greeting">
            <p>Dear ${name},</p>
            
            <p>Thank you for creating an account with Grav Clothing. We're excited to have you join our community of style enthusiasts.</p>
            
            <p>Your account has been successfully created with the following details:</p>
        </div>
        
        <div class="details">
            <div class="detail-item"><strong>Name:</strong> ${name}</div>
            <div class="detail-item"><strong>Email:</strong> ${email}</div>
            <div class="detail-item"><strong>Account Created:</strong> ${currentDate}</div>
        </div>
        
        <p>You can now access your dashboard to:</p>
        <ul>
            <li>Submit custom clothing requests</li>
            <li>Track your orders</li>
            <li>Manage your profile</li>
            <li>View your measurements</li>
            <li>Save your favorite styles</li>
        </ul>
        
        <p>
            <a href="${dashboardUrl}" class="dashboard-link">Access Your Dashboard</a>
        </p>
        
        <p>At Grav Clothing, we believe in creating clothing that reflects your personal style and fits you perfectly. Our expert tailors are ready to bring your vision to life.</p>
        
        <p>For any assistance or queries, please feel free to contact us at support@grav.in or call us at +91-XXXXXXXXXX.</p>
        
        <p>Thank you for choosing Grav Clothing. We look forward to creating something special for you.</p>
        
        <p>Best regards,<br>
        <strong>Grav Clothing Team</strong><br>
        Mayfair Lagoon Campus<br>
        Est. 2024</p>
        
        <div class="footer">
            <p>This is an automated message. Please do not reply to this email.</p>
            <p>For support, email: support@grav.in</p>
            <p>© ${new Date().getFullYear()} Grav Clothing. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
    }

    /**
     * Generate HTML request confirmation email
     */
    generateRequestConfirmationHTML(name, requestId, requestDate, itemSummary, totalItems, dashboardUrl) {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Request Confirmation - Grav Clothing</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .content {
            background-color: #ffffff;
            padding: 20px;
        }
        .greeting {
            font-size: 16px;
            margin-bottom: 20px;
        }
        .request-info {
            margin: 20px 0;
            padding: 15px;
            background-color: #f9f9f9;
            border-left: 4px solid #333;
        }
        .info-item {
            margin: 10px 0;
        }
        .items-list {
            margin: 15px 0;
            padding: 15px;
            background-color: #f5f5f5;
            border-radius: 4px;
        }
        .status {
            display: inline-block;
            background-color: #ffc107;
            color: #333;
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 14px;
            font-weight: bold;
            margin: 10px 0;
        }
        .dashboard-link {
            display: inline-block;
            background-color: #333;
            color: white;
            padding: 10px 20px;
            text-decoration: none;
            margin: 15px 0;
        }
        .steps {
            margin: 20px 0;
        }
        .step-item {
            margin: 10px 0;
            padding-left: 20px;
            position: relative;
        }
        .step-item:before {
            content: "✓";
            position: absolute;
            left: 0;
            color: #28a745;
        }
        .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            font-size: 12px;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="content">
        <div class="greeting">
            <p>Dear ${name},</p>
            
            <p>Thank you for submitting your clothing request. We have received your order details and our team is now reviewing your requirements.</p>
        </div>
        
        <div class="request-info">
            <div class="info-item"><strong>Request ID:</strong> ${requestId}</div>
            <div class="info-item"><strong>Date Submitted:</strong> ${requestDate}</div>
            <div class="info-item"><strong>Total Items:</strong> ${totalItems}</div>
            <div class="status">Status: Pending Review</div>
        </div>
        
        <div class="items-list">
            <p><strong>Items Requested:</strong></p>
            <div>${itemSummary.replace(/\n/g, '<br>')}</div>
        </div>
        
        <div class="steps">
            <p><strong>Next Steps:</strong></p>
            <div class="step-item">Our team reviews your request (1-2 business days)</div>
            <div class="step-item">We'll contact you for any clarifications if needed</div>
            <div class="step-item">Once approved, we'll begin working on your order</div>
            <div class="step-item">You'll receive updates on your dashboard</div>
        </div>
        
        <p>
            <a href="${dashboardUrl}" class="dashboard-link">Track Your Request Status</a>
        </p>
        
        <p>If you need to make any changes to your request or have any questions, please contact us at support@grav.in or call us at +91-XXXXXXXXXX.</p>
        
        <p><strong>Please quote your Request ID (${requestId}) in all communications for faster service.</strong></p>
        
        <p>Thank you for choosing Grav Clothing. We look forward to creating your bespoke clothing.</p>
        
        <p>Best regards,<br>
        <strong>Grav Clothing Team</strong><br>
        Tailoring Department<br>
        Mayfair Lagoon Campus<br>
        Est. 2024</p>
        
        <div class="footer">
            <p>This is an automated message. Please do not reply to this email.</p>
            <p>For support, email: support@grav.in</p>
            <p>© ${new Date().getFullYear()} Grav Clothing. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
    }



    /**
 * Send edit request notification email to customer
 * @param {Object} requestData - Original request information
 * @param {Object} editRequestData - Edit request information
 * @param {Object} customerData - Customer information
 * @returns {Promise<Object>} - Response from email API
 */
    async sendEditRequestNotificationEmail(requestData, editRequestData, customerData) {
        try {
            const editRequestUrl = `${this.websiteUrl}/approval-request-for-edit-functionality/${editRequestData._id}`;
            const requestDate = new Date(requestData.createdAt).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'long',
                year: 'numeric'
            });
            const editRequestDate = new Date(editRequestData.requestedAt || editRequestData.createdAt).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });

            // Generate summary of changes
            let changesSummary = '';
            if (editRequestData.changes && editRequestData.changes.length > 0) {
                editRequestData.changes.forEach(change => {
                    changesSummary += `\n- ${change.field}: Changed from "${change.oldValue}" to "${change.newValue}"`;
                });
            }

            const textContent = this.generateEditRequestNotificationText(
                customerData.name,
                requestData.requestId,
                editRequestData.reason,
                changesSummary,
                editRequestDate,
                editRequestUrl
            );

            const emailPayload = {
                sender: {
                    name: this.senderName,
                    email: this.senderEmail
                },
                to: [
                    {
                        email: customerData.email,
                        name: customerData.name || customerData.email.split('@')[0]
                    }
                ],
                subject: `Action Required: Edit Request for Order ${requestData.requestId} - Grav Clothing`,
                htmlContent: this.generateEditRequestNotificationHTML(
                    customerData.name,
                    requestData.requestId,
                    editRequestData.reason,
                    changesSummary,
                    editRequestDate,
                    editRequestUrl
                ),
                textContent: textContent,
                headers: {
                    'X-Mailin-custom': 'edit_request_notification_email'
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

            console.log(`Edit request notification email sent for ${requestData.requestId}:`, response.data);
            return { success: true, messageId: response.data.messageId };

        } catch (error) {
            console.error('Error sending edit request notification email:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.message || error.message
            };
        }
    }

    /**
     * Generate plain text edit request notification email
     */
    generateEditRequestNotificationText(name, requestId, reason, changesSummary, editRequestDate, editRequestUrl) {
        return `
Action Required: Edit Request for Your Order - Grav Clothing

Dear ${name},

We have initiated an edit request for your order (${requestId}). Our sales team has proposed some changes that require your approval before we can proceed with production.

Edit Request Details:
Order ID: ${requestId}
Edit Request Date: ${editRequestDate}
Reason for Changes: ${reason}

Proposed Changes:${changesSummary}

Your approval is required to proceed with these changes. Please review the changes carefully and approve or reject them within Hours.

Click the link below to review and respond to this edit request:
${editRequestUrl}

Important Notes:
- Please review all changes carefully before approving
- Once approved, the changes will be applied to your order
- If rejected, your original order details will remain unchanged
- If no action is taken within 24 Hours, the edit request may expire

If you have any questions about these changes or need clarification, please contact our sales team at sales@grav.in or call us at +91-XXXXXXXXXX.

Please quote your Order ID (${requestId}) in all communications for faster service.

Thank you for choosing Grav Clothing. We appreciate your prompt attention to this matter.

Best regards,
Grav Clothing Team
Sales Department
Mayfair Lagoon Campus
Est. 2024

---
This is an automated message. Please do not reply to this email.
For support, email: support@grav.in
© ${new Date().getFullYear()} Grav Clothing. All rights reserved.
`;
    }

    /**
     * Generate HTML edit request notification email
     */
    generateEditRequestNotificationHTML(name, requestId, reason, changesSummary, editRequestDate, editRequestUrl) {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Edit Request - Action Required - Grav Clothing</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .content {
            background-color: #ffffff;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header {
            background-color: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            text-align: center;
        }
        .alert {
            background-color: #fff3cd;
            border: 1px solid #ffeaa7;
            color: #856404;
            padding: 15px;
            border-radius: 4px;
            margin: 20px 0;
        }
        .request-info {
            margin: 20px 0;
            padding: 15px;
            background-color: #f9f9f9;
            border-left: 4px solid #007bff;
        }
        .info-item {
            margin: 10px 0;
            padding: 8px 0;
            border-bottom: 1px solid #eee;
        }
        .info-item:last-child {
            border-bottom: none;
        }
        .changes-list {
            margin: 15px 0;
            padding: 15px;
            background-color: #f5f5f5;
            border-radius: 4px;
        }
        .action-button {
            display: block;
            background-color: #007bff;
            color: white;
            padding: 12px 24px;
            text-decoration: none;
            margin: 20px auto;
            text-align: center;
            border-radius: 4px;
            font-weight: bold;
            max-width: 300px;
        }
        .action-button:hover {
            background-color: #0056b3;
        }
        .important-notes {
            margin: 20px 0;
            padding: 15px;
            background-color: #fff3cd;
            border-radius: 4px;
        }
        .note-item {
            margin: 8px 0;
            padding-left: 20px;
            position: relative;
        }
        .note-item:before {
            content: "•";
            position: absolute;
            left: 8px;
            color: #856404;
        }
        .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            font-size: 12px;
            color: #666;
            text-align: center;
        }
        .action-buttons {
            display: flex;
            gap: 10px;
            justify-content: center;
            margin: 25px 0;
        }
        .view-button {
            display: inline-block;
            background-color: #28a745;
            color: white;
            padding: 12px 24px;
            text-decoration: none;
            border-radius: 4px;
            font-weight: bold;
            text-align: center;
        }
        .view-button:hover {
            background-color: #218838;
        }
        .expiry-notice {
            background-color: #ffc107;
            color: #856404;
            padding: 10px;
            border-radius: 4px;
            margin: 15px 0;
            text-align: center;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="content">
        <div class="header">
            <h2 style="margin: 0; color: #333;">Edit Request - Action Required</h2>
            <p style="margin: 5px 0 0 0; color: #666;">Your approval is needed to proceed with order changes</p>
        </div>
        
        <div class="alert">
            <strong>⚠️ IMPORTANT:</strong> Please review the proposed changes to your order below and take action within 24 Hours.
        </div>
        
        <div class="greeting">
            <p>Dear <strong>${name}</strong>,</p>
            
            <p>We have initiated an edit request for your order <strong>${requestId}</strong>. Our sales team has proposed some changes that require your approval before we can proceed with production.</p>
        </div>
        
        <div class="request-info">
            <h3 style="margin-top: 0;">Edit Request Details</h3>
            <div class="info-item">
                <strong>Order ID:</strong> ${requestId}
            </div>
            <div class="info-item">
                <strong>Edit Request Date:</strong> ${editRequestDate}
            </div>
            <div class="info-item">
                <strong>Reason for Changes:</strong> ${reason}
            </div>
        </div>
        
        <div class="changes-list">
            <h4 style="margin-top: 0;">Proposed Changes</h4>
            <div>${changesSummary.replace(/\n/g, '<br>') || 'No detailed changes provided.'}</div>
        </div>
        
        <div class="expiry-notice">
            ⏰ Please respond within 24 Hours to avoid delays
        </div>
        
        <div class="action-buttons">
            <a href="${editRequestUrl}" class="view-button">View Edit Request & Respond</a>
        </div>
        
        <div class="important-notes">
            <h4 style="margin-top: 0;">Important Notes:</h4>
            <div class="note-item">Please review all changes carefully before approving</div>
            <div class="note-item">Once approved, the changes will be applied to your order</div>
            <div class="note-item">If rejected, your original order details will remain unchanged</div>
            <div class="note-item">If no action is taken within 24 Hours, the edit request may expire</div>
        </div>
        
        <p>If you have any questions about these changes or need clarification, please contact our sales team at <a href="mailto:sales@grav.in">sales@grav.in</a> or call us at <strong>+91-XXXXXXXXXX</strong>.</p>
        
        <p><strong>Please quote your Order ID (${requestId}) in all communications for faster service.</strong></p>
        
        <p>Thank you for choosing Grav Clothing. We appreciate your prompt attention to this matter.</p>
        
        <p>Best regards,<br>
        <strong>Grav Clothing Team</strong><br>
        Sales Department<br>
        Mayfair Lagoon Campus<br>
        Est. 2024</p>
        
        <div class="footer">
            <p>This is an automated message. Please do not reply to this email.</p>
            <p>For support, email: <a href="mailto:support@grav.in">support@grav.in</a></p>
            <p>© ${new Date().getFullYear()} Grav Clothing. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
    }

    /**
 * Send quotation email to customer
 * @param {Object} requestData - Request information
 * @param {Object} quotationData - Quotation information
 * @param {Object} salesPerson - Sales person/user information
 * @returns {Promise<Object>} - Response from email API
 */
    async sendQuotationEmail(requestData, quotationData, salesPerson) {
        try {
            const quotationUrl = `${this.websiteUrl}/dashboard/my-requests`;
            const dashboardUrl = `${this.websiteUrl}/dashboard`;
            const quotationNumber = quotationData.quotationNumber || `QT-${requestData.requestId}`;
            const validUntil = new Date(quotationData.validUntil || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)).toLocaleDateString('en-IN', {
                day: 'numeric',
                month: 'long',
                year: 'numeric'
            });

            // Generate items summary
            let itemsSummary = '';
            if (quotationData.items && quotationData.items.length > 0) {
                quotationData.items.forEach((item, index) => {
                    itemsSummary += `\n${index + 1}. ${item.quantity} x ${item.description || item.productName} - ₹${item.priceIncludingGST?.toFixed(2) || '0.00'}`;
                    if (item.discountPercentage > 0) {
                        itemsSummary += ` (${item.discountPercentage}% discount applied)`;
                    }
                });
            }

            // Generate charges summary
            let chargesSummary = '';
            chargesSummary += `\nSubtotal: ₹${quotationData.subtotalBeforeGST?.toFixed(2) || '0.00'}`;
            chargesSummary += `\nTotal GST: ₹${quotationData.totalGST?.toFixed(2) || '0.00'}`;

            if (quotationData.shippingCharges > 0) {
                chargesSummary += `\nShipping Charges: ₹${quotationData.shippingCharges?.toFixed(2) || '0.00'}`;
            }

            if (quotationData.customAdditionalCharges && quotationData.customAdditionalCharges.length > 0) {
                quotationData.customAdditionalCharges.forEach(charge => {
                    chargesSummary += `\n${charge.description}: ₹${charge.amount?.toFixed(2) || '0.00'}`;
                });
            }

            chargesSummary += `\nGrand Total: ₹${quotationData.grandTotal?.toFixed(2) || '0.00'}`;

            // Generate payment schedule if exists
            let paymentSchedule = '';
            if (quotationData.paymentSchedule && quotationData.paymentSchedule.length > 0) {
                quotationData.paymentSchedule.forEach((payment, index) => {
                    paymentSchedule += `\nStep ${payment.stepNumber}: ₹${payment.amount?.toFixed(2) || '0.00'} - ${payment.description || 'Payment'} (Due: ${new Date(payment.dueDate).toLocaleDateString('en-IN')})`;
                });
            }

            const textContent = this.generateQuotationEmailText(
                requestData.customerInfo.name,
                requestData.requestId,
                quotationNumber,
                validUntil,
                itemsSummary,
                chargesSummary,
                paymentSchedule,
                quotationData.grandTotal?.toFixed(2) || '0.00',
                quotationUrl,
                salesPerson.name || salesPerson.email
            );

            const emailPayload = {
                sender: {
                    name: this.senderName,
                    email: this.senderEmail
                },
                to: [
                    {
                        email: requestData.customerInfo.email,
                        name: requestData.customerInfo.name || requestData.customerInfo.email.split('@')[0]
                    }
                ],
                subject: `Grav Clothing - Quotation ${quotationNumber} for Your Request ${requestData.requestId}`,
                htmlContent: this.generateQuotationEmailHTML(
                    requestData.customerInfo.name,
                    requestData.requestId,
                    quotationNumber,
                    validUntil,
                    itemsSummary,
                    chargesSummary,
                    paymentSchedule,
                    quotationData.grandTotal?.toFixed(2) || '0.00',
                    quotationUrl,
                    salesPerson.name || salesPerson.email
                ),
                textContent: textContent,
                headers: {
                    'X-Mailin-custom': 'quotation_email'
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

            console.log(`Quotation email sent for ${quotationNumber}:`, response.data);
            return { success: true, messageId: response.data.messageId };

        } catch (error) {
            console.error('Error sending quotation email:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.message || error.message
            };
        }
    }

    /**
     * Generate plain text quotation email
     */
    generateQuotationEmailText(name, requestId, quotationNumber, validUntil, itemsSummary, chargesSummary, paymentSchedule, grandTotal, quotationUrl, salesPersonName) {
        return `
Grav Clothing - Quotation for Your Custom Clothing Request

Dear ${name},

We are pleased to present you with a quotation for your custom clothing request.

Request Details:
Request ID: ${requestId}
Quotation Number: ${quotationNumber}
Valid Until: ${validUntil}
Prepared By: ${salesPersonName}

Quotation Summary:${itemsSummary}

Charges Breakdown:${chargesSummary}

${paymentSchedule ? `Payment Schedule:\n${paymentSchedule}\n` : ''}

Grand Total Amount: ₹${grandTotal}

You can view and approve this quotation online by clicking the link below:
${quotationUrl}

Next Steps:
1. Review the quotation details carefully
2. Approve the quotation online if everything looks good
3. If you have any questions or need modifications, please contact our sales team
4. The quotation is valid until ${validUntil}

Important Notes:
- This quotation includes all taxes and charges
- Prices are valid until the validity date mentioned above
- Once approved, our team will proceed with production
- You can track your order status in your dashboard

For any queries or modifications, please contact our sales team at sales@grav.in or call us at +91-XXXXXXXXXX.

Please quote your Quotation Number (${quotationNumber}) in all communications for faster service.

Thank you for choosing Grav Clothing. We look forward to creating your bespoke clothing.

Best regards,
Grav Clothing Team
Sales Department
Mayfair Lagoon Campus
Est. 2024

---
This is an automated message. Please do not reply to this email.
For support, email: support@grav.in
© ${new Date().getFullYear()} Grav Clothing. All rights reserved.
`;
    }

    /**
     * Generate HTML quotation email
     */
    generateQuotationEmailHTML(name, requestId, quotationNumber, validUntil, itemsSummary, chargesSummary, paymentSchedule, grandTotal, quotationUrl, salesPersonName) {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Quotation - Grav Clothing</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
        }
        .content {
            background-color: #ffffff;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header {
            background-color: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            text-align: center;
        }
        .quotation-info {
            margin: 20px 0;
            padding: 15px;
            background-color: #e8f4f8;
            border-left: 4px solid #007bff;
        }
        .info-item {
            margin: 8px 0;
            display: flex;
            justify-content: space-between;
        }
        .info-label {
            font-weight: bold;
            color: #555;
        }
        .info-value {
            color: #333;
        }
        .validity {
            background-color: #fff3cd;
            padding: 10px;
            border-radius: 4px;
            text-align: center;
            margin: 15px 0;
            border: 1px solid #ffeaa7;
        }
        .items-section {
            margin: 20px 0;
            padding: 15px;
            background-color: #f9f9f9;
            border-radius: 4px;
        }
        .charges-section {
            margin: 20px 0;
            padding: 15px;
            background-color: #f5f5f5;
            border-radius: 4px;
        }
        .total-amount {
            background-color: #28a745;
            color: white;
            padding: 15px;
            border-radius: 4px;
            text-align: center;
            font-size: 24px;
            font-weight: bold;
            margin: 20px 0;
        }
        .action-button {
            display: block;
            background-color: #007bff;
            color: white;
            padding: 12px 24px;
            text-decoration: none;
            margin: 20px auto;
            text-align: center;
            border-radius: 4px;
            font-weight: bold;
            max-width: 300px;
        }
        .action-button:hover {
            background-color: #0056b3;
        }
        .steps {
            margin: 20px 0;
        }
        .step-item {
            margin: 10px 0;
            padding-left: 25px;
            position: relative;
        }
        .step-item:before {
            content: counter(step);
            counter-increment: step;
            position: absolute;
            left: 0;
            background-color: #007bff;
            color: white;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            text-align: center;
            line-height: 20px;
            font-size: 12px;
        }
        .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            font-size: 12px;
            color: #666;
            text-align: center;
        }
        .payment-schedule {
            margin: 15px 0;
            padding: 15px;
            background-color: #e7f3ff;
            border-radius: 4px;
        }
        .payment-item {
            margin: 8px 0;
            padding: 8px;
            background-color: white;
            border-radius: 3px;
        }
    </style>
</head>
<body>
    <div class="content">
        <div class="header">
            <h2 style="margin: 0; color: #333;">Your Quotation is Ready!</h2>
            <p style="margin: 5px 0 0 0; color: #666;">Grav Clothing - Custom Tailoring</p>
        </div>
        
        <div class="greeting">
            <p>Dear <strong>${name}</strong>,</p>
            <p>We are pleased to present you with a quotation for your custom clothing request.</p>
        </div>
        
        <div class="quotation-info">
            <h3 style="margin-top: 0; color: #007bff;">Quotation Details</h3>
            <div class="info-item">
                <span class="info-label">Request ID:</span>
                <span class="info-value">${requestId}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Quotation Number:</span>
                <span class="info-value">${quotationNumber}</span>
            </div>
            <div class="info-item">
                <span class="info-label">Prepared By:</span>
                <span class="info-value">${salesPersonName}</span>
            </div>
        </div>
        
        <div class="validity">
            ⏰ <strong>Valid Until:</strong> ${validUntil}
        </div>
        
        <div class="items-section">
            <h4 style="margin-top: 0;">Items Included:</h4>
            <div>${itemsSummary.replace(/\n/g, '<br>')}</div>
        </div>
        
        <div class="charges-section">
            <h4 style="margin-top: 0;">Charges Breakdown:</h4>
            <div>${chargesSummary.replace(/\n/g, '<br>')}</div>
        </div>
        
        ${paymentSchedule ? `
        <div class="payment-schedule">
            <h4 style="margin-top: 0;">Payment Schedule:</h4>
            <div>${paymentSchedule.replace(/\n/g, '<br>')}</div>
        </div>
        ` : ''}
        
        <div class="total-amount">
            Grand Total: ₹${grandTotal}
        </div>
        
        <a href="${quotationUrl}" class="action-button">Review & Approve Quotation</a>
        
        <div class="steps">
            <h4>Next Steps:</h4>
            <div class="step-item">Review the quotation details carefully</div>
            <div class="step-item">Approve the quotation online if everything looks good</div>
            <div class="step-item">Contact our sales team for any questions or modifications</div>
            <div class="step-item">Track your order status in your dashboard</div>
        </div>
        
        <p><strong>Important Notes:</strong></p>
        <ul>
            <li>This quotation includes all taxes and charges</li>
            <li>Prices are valid until the validity date mentioned above</li>
            <li>Once approved, our team will proceed with production</li>
            <li>You can track your order status in your dashboard</li>
        </ul>
        
        <p>For any queries or modifications, please contact our sales team at <a href="mailto:sales@grav.in">sales@grav.in</a> or call us at <strong>+91-XXXXXXXXXX</strong>.</p>
        
        <p><strong>Please quote your Quotation Number (${quotationNumber}) in all communications for faster service.</strong></p>
        
        <p>Thank you for choosing Grav Clothing. We look forward to creating your bespoke clothing.</p>
        
        <p>Best regards,<br>
        <strong>Grav Clothing Team</strong><br>
        Sales Department<br>
        Mayfair Lagoon Campus<br>
        Est. 2024</p>
        
        <div class="footer">
            <p>This is an automated message. Please do not reply to this email.</p>
            <p>For support, email: <a href="mailto:support@grav.in">support@grav.in</a></p>
            <p>© ${new Date().getFullYear()} Grav Clothing. All rights reserved.</p>
        </div>
    </div>
</body>
</html>`;
    }








    /**
     * Send order confirmation email
     * @param {Object} orderData - Order information
     */
    async sendOrderConfirmationEmail(orderData) {
        // For future implementation
        return { success: true };
    }

    /**
     * Send measurement reminder email
     * @param {Object} customerData - Customer information
     */
    async sendMeasurementReminderEmail(customerData) {
        // For future implementation
        return { success: true };
    }
}

module.exports = new CustomerEmailService();