require('dotenv').config();
const nodemailer = require('nodemailer');

console.log('Testing SMTP configuration...');
console.log('SMTP Settings:');
console.log('- Host:', process.env.SMTP_HOST);
console.log('- Port:', process.env.SMTP_PORT);
console.log('- User:', process.env.SMTP_USER);
console.log('- From:', process.env.SMTP_FROM_EMAIL);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT, 10) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD
  },
  connectionTimeout: 5000,
  socketTimeout: 5000
});

console.log('\nTesting SMTP connection...');
transporter.verify((error, success) => {
  if (error) {
    console.error('SMTP Connection Error:', error);
    process.exit(1);
  } else {
    console.log('✓ SMTP Server is ready!');
    
    // Try sending test email
    console.log('\nSending test email...');
    const mailOptions = {
      from: `"Studentska Sluzhba" <${process.env.SMTP_FROM_EMAIL}>`,
      to: 'test@example.com',
      subject: 'Test Email',
      html: '<h1>Test</h1><p>This is a test email</p>'
    };
    
    transporter.sendMail(mailOptions, (err, info) => {
      if (err) {
        console.error('Email send error:', err);
        process.exit(1);
      } else {
        console.log('✓ Email sent successfully!');
        console.log('Message ID:', info.messageId);
        process.exit(0);
      }
    });
  }
});

// Timeout after 15 seconds
setTimeout(() => {
  console.error('Timeout: SMTP took too long to respond');
  process.exit(1);
}, 15000);
