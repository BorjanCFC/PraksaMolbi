'use strict';

// MOLBI_INDEX_FROM_EMAIL_MANUAL_MAJOR_V1
const { Student } = require('../models');

/*
 * Direction/major is intentionally NOT parsed from the e-mail.
 * The e-mail is used only as the source of truth for brIndeks.
 */
const ALLOWED_STUDENT_EMAIL_DOMAINS = new Set([
  'feit.ukim.edu.mk',
  'studenti.feit.ukim.edu.mk'
]);

const normalizeEmail = (email) =>
  String(email || '').trim().toLowerCase();

/**
 * Examples:
 *   kti982022@feit.ukim.edu.mk  -> 98/2022
 *   ksiar1062022@feit.ukim.edu.mk -> 106/2022
 *
 * Rules:
 * 1. take everything left of @;
 * 2. take the consecutive digit sequence at the END of that local-part;
 * 3. last four digits are enrollment year;
 * 4. insert '/' before those last four digits.
 *
 * The prefix is deliberately ignored. It does NOT determine smer.
 */
const parseStudentIndexFromEmail = (email) => {
  const normalized = normalizeEmail(email);
  const atIndex = normalized.lastIndexOf('@');

  if (atIndex <= 0) {
    return null;
  }

  const localPart = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);

  if (!ALLOWED_STUDENT_EMAIL_DOMAINS.has(domain)) {
    return null;
  }

  const digitMatch = localPart.match(/(\d+)$/);

  if (!digitMatch) {
    return null;
  }

  const rawIndex = digitMatch[1];

  // At least one index-number digit + four year digits.
  if (rawIndex.length < 5) {
    return null;
  }

  const enrollmentYear = rawIndex.slice(-4);
  const indexNumber = rawIndex.slice(0, -4);

  if (!indexNumber || !/^\d+$/.test(indexNumber) || !/^\d{4}$/.test(enrollmentYear)) {
    return null;
  }

  return {
    rawIndex,
    indexNumber,
    enrollmentYear,
    brIndeks: `${indexNumber}/${enrollmentYear}`
  };
};

/**
 * Persist ONLY brIndeks.
 * Existing Student.smer is preserved exactly as it is because the student
 * chooses/changes it manually through the request forms.
 */
const syncStudentIndexFromEmail = async (userLike, options = {}) => {
  if (!userLike || !userLike.userId) {
    return {
      parsed: null,
      profile: null,
      updated: false
    };
  }

  const parsed = parseStudentIndexFromEmail(userLike.email);

  if (!parsed) {
    return {
      parsed: null,
      profile: null,
      updated: false
    };
  }

  const queryOptions = {};
  if (options.transaction) {
    queryOptions.transaction = options.transaction;
  }

  const [profile, created] = await Student.findOrCreate({
    where: {
      userId: userLike.userId
    },
    defaults: {
      brIndeks: parsed.brIndeks,
      smer: null
    },
    ...queryOptions
  });

  let updated = created;

  if (profile.brIndeks !== parsed.brIndeks) {
    await profile.update(
      {
        brIndeks: parsed.brIndeks
      },
      queryOptions
    );

    updated = true;
  }

  return {
    parsed,
    profile,
    updated
  };
};

module.exports = {
  ALLOWED_STUDENT_EMAIL_DOMAINS,
  parseStudentIndexFromEmail,
  syncStudentIndexFromEmail
};
