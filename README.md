# PraksaMolbi - Систем за електронско поднесување молби

Апликација за реален workflow на молби со повеќе улоги, документи и одлуки.

## Што е имплементирано

- Најава со корисници од база (без hardcoded admin)
- Модел на база според ERD:
  - `roles` (`roleId`, `tip`) каде `tip` е: `Admin`, `Sluzhba`, `Prodekan`, `Arhiva`
  - `users` (`userId`, `roleId`, `ime`, `prezime`, `email`, `password`)
  - `students` (`userId`, `brIndeks`, `smer`) како подкласа на `users`
  - `molbi` (`molbaId`, `userId`, `status`, `datum`, `naslov`, `description`, `feedback`)
- Улоги:
  - `student`
  - `admin` (глобален пристап + преземање студентски акаунт)
  - `studentska_sluzhba`
  - `prodekan`
  - `arhiva`
- Поднесување молба со:
  - наслов
  - опис
  - опционален документ (PDF/слика)
- Детали на молба:
  - симнување студентски документ
  - промена статус (служба/продекан/админ)
- Архива role:
  - преглед + download документи
  - нема право на промена статус
- PostgreSQL конфигурација

## Технологии

- Node.js: `v24.14.0`
- Express: `^4.18.2`
- Sequelize ORM: `^6.35.0`
- Sequelize CLI: `^6.6.2`
- PostgreSQL driver (`pg`): `^8.15.6`
- EJS: `^3.1.9`
- Multer: `^2.0.2`
- bcryptjs: `^2.4.3`
- dotenv: `^16.3.1`
- express-session: `^1.17.3`
- connect-flash: `^0.1.1`
- nodemon (dev): `^3.0.2`
- PostgreSQL сервер (барано): `18`

## Инсталација

1. Инсталирај dependencies:

```bash
npm install
```

2. Креирај `.env` 

3. Пушти seed за почетни корисници и молби:

```bash
npm run seed
```

`seed` прави целосен reset на постоечката база и ја креира новата шема.

4. Стартувај апликација:

```bash
npm start
```

## PostgreSQL подесување

Потребна е PostgreSQL 18 инстанца и база.

Пример SQL:

```sql
CREATE DATABASE praksa_molbi;
```

## Тест акаунти (по seed)

- `marko.petrovski@student.mk / password123` (student)
- `admin@university.mk / password123` (admin)
- `sluzhba@university.mk / password123` (studentska_sluzhba)
- `prodekan@university.mk / password123` (prodekan)
- `arhiva@university.mk / password123` (arhiva)

## Upload ограничувања

- Дозволени типови: PDF, PNG, JPG, JPEG, WEBP
- Максимална големина: 15MB
