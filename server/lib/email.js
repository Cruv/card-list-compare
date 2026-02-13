import { createTransport } from 'nodemailer';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || 'noreply@cardlistcompare.local';
const APP_URL = process.env.APP_URL || 'http://localhost:8080';

let transporter = null;

export function isEmailConfigured() {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

export function getAppUrl() {
  return APP_URL;
}

function getTransporter() {
  if (!transporter && isEmailConfigured()) {
    transporter = createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });
  }
  return transporter;
}

export async function sendEmail(to, subject, html) {
  const t = getTransporter();
  if (!t) {
    console.warn('Email not configured — skipping send to', to);
    return false;
  }

  try {
    await t.sendMail({
      from: SMTP_FROM,
      to,
      subject,
      html,
    });
    return true;
  } catch (err) {
    console.error('Failed to send email:', err.message);
    return false;
  }
}

export async function sendPasswordResetEmail(email, token) {
  const resetUrl = `${APP_URL}?reset=${token}`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #333;">Reset Your Password</h2>
      <p>You requested a password reset for your Card List Compare account.</p>
      <p>
        <a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background: #3b82f6; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Reset Password
        </a>
      </p>
      <p style="color: #666; font-size: 13px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
      <p style="color: #999; font-size: 11px;">Card List Compare</p>
    </div>
  `;
  return sendEmail(email, 'Reset your Card List Compare password', html);
}

export async function sendVerificationEmail(email, token) {
  const verifyUrl = `${APP_URL}?verify=${token}`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #333;">Verify Your Email</h2>
      <p>Please verify your email address for your Card List Compare account.</p>
      <p>
        <a href="${verifyUrl}" style="display: inline-block; padding: 12px 24px; background: #16a34a; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 600;">
          Verify Email
        </a>
      </p>
      <p style="color: #666; font-size: 13px;">This link expires in 24 hours. If you didn't request this, you can safely ignore this email.</p>
      <p style="color: #999; font-size: 11px;">Card List Compare</p>
    </div>
  `;
  return sendEmail(email, 'Verify your Card List Compare email', html);
}
