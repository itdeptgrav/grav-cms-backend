// /service/emailService.js

const axios = require('axios');

class EmailService {
    constructor() {
        this.apiKey = process.env.BREVO_API_KEY;
        this.senderEmail = "biswalpramod3.1415@gmail.com";
        this.senderName = "Grav HR";
        this.baseUrl = "https://api.brevo.com/v3";
    }

    /**
     * Send welcome email to new employee
     * @param {Object} employeeData - Employee information
     * @param {string} employeeData.email - Employee email
     * @param {string} employeeData.name - Employee name
     * @param {string} employeeData.employeeId - Employee ID
     * @param {string} temporaryPassword - Temporary password
     * @returns {Promise<Object>} - Response from email API
     */
    async sendWelcomeEmail(employeeData, temporaryPassword) {
        try {
            const loginUrl = "https://cms.grav.in/login";

            // Email template directly in JS
            const htmlContent = this.generateWelcomeEmailTemplate(
                employeeData.name,
                employeeData.email,
                temporaryPassword,
                loginUrl,
                employeeData.employeeId
            );

            const emailPayload = {
                sender: {
                    name: this.senderName,
                    email: this.senderEmail
                },
                to: [
                    {
                        email: employeeData.email,
                        name: employeeData.name || employeeData.email.split('@')[0]
                    }
                ],
                subject: `Welcome to Grav - Your Employee Dashboard Access`,
                htmlContent: htmlContent,
                textContent: this.generatePlainTextContent(
                    employeeData.name,
                    employeeData.email,
                    temporaryPassword,
                    loginUrl,
                    employeeData.employeeId
                ),
                headers: {
                    'X-Mailin-custom': 'employee_welcome_email'
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

            console.log(`Welcome email sent to ${employeeData.email}:`, response.data);
            return { success: true, messageId: response.data.messageId };

        } catch (error) {
            console.error('Error sending welcome email:', error.response?.data || error.message);
            throw new Error(`Failed to send email: ${error.response?.data?.message || error.message}`);
        }
    }

    /**
     * Generate HTML email template
     */
    generateWelcomeEmailTemplate(name, email, password, loginUrl, employeeId) {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to Grav</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f4f4f4;
        }
        .email-container {
            background-color: #ffffff;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 25px 20px;
            text-align: center;
        }
        .header h1 {
            margin: 0;
            font-size: 24px;
        }
        .content {
            padding: 30px;
        }
        .greeting {
            font-size: 18px;
            margin-bottom: 20px;
            color: #2d3748;
        }
        .credentials-box {
            background-color: #f7fafc;
            border: 1px solid #e2e8f0;
            border-radius: 6px;
            padding: 20px;
            margin: 20px 0;
        }
        .credential-item {
            margin: 10px 0;
            padding: 8px 0;
            border-bottom: 1px solid #edf2f7;
        }
        .credential-item:last-child {
            border-bottom: none;
        }
        .label {
            font-weight: 600;
            color: #4a5568;
            display: inline-block;
            width: 120px;
        }
        .value {
            color: #2d3748;
        }
        .highlight {
            background-color: #fff5f5;
            border: 1px solid #fed7d7;
            color: #c53030;
            padding: 12px;
            border-radius: 4px;
            margin: 15px 0;
            font-size: 14px;
        }
        .login-button {
            display: inline-block;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 12px 30px;
            text-decoration: none;
            border-radius: 5px;
            font-weight: 600;
            margin: 15px 0;
            text-align: center;
        }
        .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #e2e8f0;
            font-size: 12px;
            color: #718096;
            text-align: center;
        }
        .note {
            font-size: 13px;
            color: #4a5568;
            margin-top: 5px;
        }
    </style>
</head>
<body>
    <div class="email-container">
        <div class="header">
            <h1>Welcome to Grav</h1>
        </div>
        
        <div class="content">
            <div class="greeting">
                Dear <strong>${name || 'Employee'}</strong>,
            </div>
            
            <p>Congratulations and a very warm welcome to our team! We are thrilled to have you onboard.</p>
            
            <p>Your employee dashboard has been successfully created. Please find your login credentials below:</p>
            
            <div class="credentials-box">
                <div class="credential-item">
                    <span class="label">Employee ID:</span>
                    <span class="value">${employeeId || 'Not Assigned'}</span>
                </div>
                <div class="credential-item">
                    <span class="label">Email:</span>
                    <span class="value">${email}</span>
                </div>
                <div class="credential-item">
                    <span class="label">Temporary Password:</span>
                    <span class="value"><strong>${password}</strong></span>
                </div>
                <div class="credential-item">
                    <span class="label">Dashboard URL:</span>
                    <span class="value">${loginUrl}</span>
                </div>
            </div>
            
            <div class="highlight">
                🔐 <strong>Important Security Note:</strong> For security purposes, please change your temporary password immediately after your first login.
            </div>
            
            <p>To access your dashboard and get started, click the button below:</p>
            
            <div style="text-align: center;">
                <a href="${loginUrl}" class="login-button">
                    🚀 Access Your Dashboard
                </a>
            </div>
            
            <p class="note">If the button doesn't work, copy and paste this URL in your browser:<br>${loginUrl}</p>
            
            <p>Best regards,<br>
            <strong>HR Team</strong><br>
            Grav Clothing</p>
            
            <div class="footer">
                <p>This is an automated email. Please do not reply to this message.</p>
                <p>If you need assistance, please contact the HR department.</p>
                <p>© ${new Date().getFullYear()} Grav Clothing. All rights reserved.</p>
            </div>
        </div>
    </div>
</body>
</html>`;
    }

    /**
     * Generate plain text alternative for email
     */
    generatePlainTextContent(name, email, password, loginUrl, employeeId) {
        return `
WELCOME TO GRAV

Dear ${name || 'Employee'},

Congratulations and welcome to our team! We are delighted to have you on board.

Your employee dashboard has been successfully created. Here are your login credentials:

Employee ID: ${employeeId || 'Not Assigned'}
Email: ${email}
Temporary Password: ${password}
Dashboard URL: ${loginUrl}

IMPORTANT: For security purposes, please change your temporary password immediately after your first login.

To access your dashboard, visit: ${loginUrl}

Best regards,
HR Team
Grav Clothing

---
This is an automated email. Please do not reply to this message.
If you need assistance, please contact the HR department.
© ${new Date().getFullYear()} Grav Clothing. All rights reserved.
`;
    }

    /**
     * Send password reset email
     * @param {Object} employeeData - Employee information
     * @param {string} resetToken - Password reset token
     */
    async sendPasswordResetEmail(employeeData, resetToken) {
        // You can add other email templates here as needed
        // For future implementation
    }
}

module.exports = new EmailService();