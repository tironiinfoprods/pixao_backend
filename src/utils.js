import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

export const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });

export const hashPassword = async (pwd) => bcrypt.hash(pwd, 10);

export const comparePassword = async (pwd, hash) => bcrypt.compare(pwd, hash);

export const priceFromCents = (cents) => (cents / 100).toFixed(2);
