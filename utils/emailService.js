const nodemailer = require('nodemailer');
const path = require('path');
const { convertNameToCyrillic } = require('./cyrillicConverter');

const SMTP_HOST = (process.env.SMTP_HOST || 'smail.feit.ukim.edu.mk').trim();
const SMTP_PORT = parseInt((process.env.SMTP_PORT || '587').trim(), 10);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false') === 'true';
const SMTP_REQUIRE_TLS = String(process.env.SMTP_REQUIRE_TLS || 'true') === 'true';

const SMTP_USER = (process.env.SMTP_USER || '').trim();

// Не бриши spaces автоматски, затоа што ова веќе не е Gmail app password.
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || '';

const SMTP_FROM_NAME = (process.env.SMTP_FROM_NAME || 'Студентска служба ФЕИТ').trim();
const SMTP_FROM_EMAIL = (process.env.SMTP_FROM_EMAIL || SMTP_USER).trim();

const SMTP_TLS_REJECT_UNAUTHORIZED =
  String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED || 'true') === 'true';

const SMTP_TLS_CIPHERS =
  process.env.SMTP_TLS_CIPHERS || 'DEFAULT:@SECLEVEL=1';

const SMTP_SERVERNAME =
  process.env.SMTP_SERVERNAME || SMTP_HOST;

const SMTP_DEBUG =
  String(process.env.SMTP_DEBUG || 'false') === 'true';

console.log('[EmailService] Initializing with SMTP config:', {
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  requireTLS: SMTP_REQUIRE_TLS,
  user: SMTP_USER,
  from: SMTP_FROM_EMAIL
});

if (!SMTP_USER || !SMTP_PASSWORD) {
  console.warn('[EmailService] WARNING: SMTP_USER or SMTP_PASSWORD is missing.');
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,

  auth: {
    user: SMTP_USER,
    pass: SMTP_PASSWORD
  },

  requireTLS: SMTP_REQUIRE_TLS,

  tls: {
    servername: SMTP_SERVERNAME,
    rejectUnauthorized: SMTP_TLS_REJECT_UNAUTHORIZED,
    ciphers: SMTP_TLS_CIPHERS,
    minVersion: 'TLSv1.2'
  },

  connectionTimeout: 30000,
  greetingTimeout: 30000,
  socketTimeout: 30000,

  logger: SMTP_DEBUG,
  debug: SMTP_DEBUG
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
    subject: 'Потврда за успешно поднесена молба',
    html: `
      <div style="
        max-width: 650px;
        margin: 0 auto;
        font-family: Arial, Helvetica, sans-serif;
        color: #333333;
        line-height: 1.6;
        border: 1px solid #e5e5e5;
        border-radius: 8px;
        overflow: hidden;
      ">

        <div style="
          background-color: #f4f6f8;
          padding: 24px 30px;
          border-bottom: 1px solid #e5e5e5;
        ">
          <h2 style="
            margin: 0;
            font-size: 22px;
            color: #222222;
          ">
            Потврда за успешно поднесена молба
          </h2>
        </div>

        <div style="padding: 30px;">
          <p>Почитуван/а ${safeStudentName},</p>

          <p>
            Ве известуваме дека Вашата молба со наслов
            <strong>„${safeMolbaTitle}“</strong>
            е успешно поднесена и е евидентирана во системот.
          </p>

          <p>
            Молбата ќе биде разгледана од страна на надлежните служби
            согласно утврдената постапка.
          </p>

          <p>
            По завршувањето на постапката, ќе добиете дополнително
            известување.
          </p>

          <p style="margin-top: 30px;">
            Со почит,<br/>
            <strong>Студентска служба</strong><br/>
            Факултет за електротехника и информациски технологии – Скопје
          </p>
        </div>

        <div style="
          background-color: #f8f8f8;
          padding: 15px 30px;
          font-size: 12px;
          color: #777777;
          border-top: 1px solid #e5e5e5;
        ">
          Оваа порака е автоматски генерирана од системот за електронско
          поднесување и обработка на студентски молби.
        </div>

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
    subject: 'Известување за одобрена молба',
    html: `
      <div style="
        max-width: 650px;
        margin: 0 auto;
        font-family: Arial, Helvetica, sans-serif;
        color: #333333;
        line-height: 1.6;
        border: 1px solid #e5e5e5;
        border-radius: 8px;
        overflow: hidden;
      ">

        <div style="
          background-color: #f4f6f8;
          padding: 24px 30px;
          border-bottom: 1px solid #e5e5e5;
        ">
          <h2 style="
            margin: 0;
            font-size: 22px;
            color: #222222;
          ">
            Известување за одобрена молба
          </h2>
        </div>

        <div style="padding: 30px;">
          <p>Почитуван/а ${safeStudentName},</p>

          <p>
            Ве известуваме дека Вашата молба со наслов
            <strong>„${safeMolbaTitle}“</strong>
            е разгледана и <strong>одобрена</strong>.
          </p>

          <p>
            Во прилог на оваа порака Ви го доставуваме официјално
            генерираниот PDF документ поврзан со Вашата молба.
          </p>

          <p style="margin-top: 30px;">
            Со почит,<br/>
            <strong>Студентска служба</strong><br/>
            Факултет за електротехника и информациски технологии – Скопје
          </p>
        </div>

        <div style="
          background-color: #f8f8f8;
          padding: 15px 30px;
          font-size: 12px;
          color: #777777;
          border-top: 1px solid #e5e5e5;
        ">
          Оваа порака е автоматски генерирана од системот за електронско
          поднесување и обработка на студентски молби.
        </div>

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
const sendMolbaRejectedEmail = async (
  studentEmail,
  studentName,
  molbaTitle,
  feedback
) => {
  console.log(`[EmailService] Preparing to send "molba rejected" email to: ${studentEmail}`);

  const cyrillicName = convertNameToCyrillic(studentName);
  const safeStudentName = escapeHtml(cyrillicName);
  const safeMolbaTitle = escapeHtml(molbaTitle);
  const safeFeedback = escapeHtml(feedback);

  return sendMail({
    to: studentEmail,
    subject: 'Известување за одбиена молба',
    html: `
      <div style="
        max-width: 650px;
        margin: 0 auto;
        font-family: Arial, Helvetica, sans-serif;
        color: #333333;
        line-height: 1.6;
        border: 1px solid #e5e5e5;
        border-radius: 8px;
        overflow: hidden;
      ">

        <div style="
          background-color: #f4f6f8;
          padding: 24px 30px;
          border-bottom: 1px solid #e5e5e5;
        ">
          <h2 style="
            margin: 0;
            font-size: 22px;
            color: #222222;
          ">
            Известување за одбиена молба
          </h2>
        </div>

        <div style="padding: 30px;">
          <p>Почитуван/а ${safeStudentName},</p>

          <p>
            Ве известуваме дека Вашата молба со наслов
            <strong>„${safeMolbaTitle}“</strong>
            е разгледана од страна на надлежните служби и не е одобрена.
          </p>

          ${
            safeFeedback
              ? `
                <div style="
                  margin: 24px 0;
                  padding: 18px 20px;
                  background-color: #f7f7f7;
                  border-left: 4px solid #999999;
                  border-radius: 4px;
                ">
                  <strong>Образложение:</strong>
                  <p style="margin-bottom: 0;">
                    ${safeFeedback}
                  </p>
                </div>
              `
              : ''
          }

          <p>
            Доколку Ви се потребни дополнителни информации во врска со
            донесената одлука, можете да се обратите до Студентската служба
            на ФЕИТ.
          </p>

          <p style="margin-top: 30px;">
            Со почит,<br/>
            <strong>Студентска служба</strong><br/>
            Факултет за електротехника и информациски технологии – Скопје
          </p>
        </div>

        <div style="
          background-color: #f8f8f8;
          padding: 15px 30px;
          font-size: 12px;
          color: #777777;
          border-top: 1px solid #e5e5e5;
        ">
          Оваа порака е автоматски генерирана од системот за електронско
          поднесување и обработка на студентски молби.
        </div>

      </div>
    `
  });
};

module.exports = {
  sendMolbaCreatedEmail,
  sendMolbaApprovedEmail,
  sendMolbaRejectedEmail
};