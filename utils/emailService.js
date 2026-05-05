const nodemailer = require('nodemailer');
const path = require('path');
const { convertNameToCyrillic } = require('./cyrillicConverter');

const SMTP_HOST = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
const SMTP_PORT = parseInt((process.env.SMTP_PORT || '587').trim(), 10);
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASSWORD = (process.env.SMTP_PASSWORD || '').replace(/\s/g, '');
const SMTP_FROM_NAME = (process.env.SMTP_FROM_NAME || 'Студентска служба ФЕИТ').trim();
const SMTP_FROM_EMAIL = (process.env.SMTP_FROM_EMAIL || SMTP_USER).trim();

console.log('[EmailService] Initializing with SMTP config:', {
  host: SMTP_HOST,
  port: SMTP_PORT,
  user: SMTP_USER,
  from: SMTP_FROM_EMAIL
});

if (!SMTP_USER || !SMTP_PASSWORD) {
  console.warn('[EmailService] WARNING: SMTP_USER or SMTP_PASSWORD is missing.');
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASSWORD
  },

  // Gmail sometimes needs more than 5-8 seconds
  connectionTimeout: 30000,
  greetingTimeout: 30000,
  socketTimeout: 30000,

  // Helps with debugging
  logger: true,
  debug: true
});

transporter.verify()
  .then(() => {
    console.log('[EmailService] SMTP Server is ready to send emails');
  })
  .catch((error) => {
    console.error('[EmailService] SMTP Connection Error:', error.message);
  });

const escapeHtml = (value) => {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const sendMail = async (mailOptions) => {
  try {
    console.log('[EmailService] Sending email via SMTP...');

    const result = await transporter.sendMail({
      ...mailOptions,
      from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`
    });

    console.log('[EmailService] Email sent successfully! Message ID:', result.messageId);
    return true;
  } catch (error) {
    console.error('[EmailService] Error sending email:', error.message);
    console.error('[EmailService] Full error:', error);
    return false;
  }
};

/**
 * Send email to student when molba is created
 */
const sendMolbaCreatedEmail = async (studentEmail, studentName, molbaTitle) => {
  console.log(`[EmailService] Preparing to send "molba created" email to: ${studentEmail}`);

  const cyrillicName = convertNameToCyrillic(studentName);
  const safeStudentName = escapeHtml(cyrillicName);
  const safeMolbaTitle = escapeHtml(molbaTitle);

  return sendMail({
    to: studentEmail,
    subject: 'Молбата е успешно примена',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Молбата е успешно примена</h2>
        <p>Добар ден ${safeStudentName},</p>
        <p>Вашата молба <strong>"${safeMolbaTitle}"</strong> е успешно примена и ќе се обработи.</p>
        <p>Ве молиме почекајте за дополнителни информации.</p>
        <br/>
        <p>Студентска служба ФЕИТ</p>
      </div>
    `
  });
};

/**
 * Send email to student when molba is approved with PDF attachment
 */
const sendMolbaApprovedEmail = async (studentEmail, studentName, molbaTitle, pdfPath) => {
  console.log(`[EmailService] Preparing to send "molba approved" email to: ${studentEmail}`);

  const cyrillicName = convertNameToCyrillic(studentName);
  const safeStudentName = escapeHtml(cyrillicName);
  const safeMolbaTitle = escapeHtml(molbaTitle);

  return sendMail({
    to: studentEmail,
    subject: 'Молбата е одобрена',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Молбата е одобрена</h2>
        <p>Добар ден ${safeStudentName},</p>
        <p>Вашата молба <strong>"${safeMolbaTitle}"</strong> е одобрена.</p>
        <p>Во прилог го испраќаме генерираниот PDF документ.</p>
        <br/>
        <p>Студентска служба ФЕИТ</p>
      </div>
    `,
    attachments: [
      {
        filename: path.basename(pdfPath),
        path: pdfPath
      }
    ]
  });
};

/**
 * Send email to student when molba is rejected
 */
const sendMolbaRejectedEmail = async (studentEmail, studentName, molbaTitle, feedback) => {
  console.log(`[EmailService] Preparing to send "molba rejected" email to: ${studentEmail}`);

  const cyrillicName = convertNameToCyrillic(studentName);
  const safeStudentName = escapeHtml(cyrillicName);
  const safeMolbaTitle = escapeHtml(molbaTitle);
  const safeFeedback = escapeHtml(feedback);

  return sendMail({
    to: studentEmail,
    subject: 'Молбата е одбиена',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>Молбата е одбиена</h2>
        <p>Добар ден ${safeStudentName},</p>
        <p>За жал, вашата молба <strong>"${safeMolbaTitle}"</strong> е одбиена.</p>
        ${
          safeFeedback
            ? `<p><strong>Причина:</strong></p><p>${safeFeedback}</p>`
            : ''
        }
        <br/>
        <p>За дополнителни информации, контактирајте ја студентската служба.</p>
        <br/>
        <p>Студентска служба ФЕИТ</p>
      </div>
    `
  });
};

module.exports = {
  sendMolbaCreatedEmail,
  sendMolbaApprovedEmail,
  sendMolbaRejectedEmail
};