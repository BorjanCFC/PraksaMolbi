require('dotenv').config();

const commonConfig = {
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  dialect: 'postgres',
  logging: false,

  dialectOptions:
    process.env.DB_SSL === 'true'
      ? {
          ssl: {
            require: true,
            rejectUnauthorized: false
          }
        }
      : {}
};

module.exports = {
  development: {    
    ...commonConfig
  },

  test: {
    ...commonConfig
  },

  production: {
    ...commonConfig
  }
};