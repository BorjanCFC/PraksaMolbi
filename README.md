# PraksaMolbi - Систем за електронско поднесување молби

Апликација за реален workflow на молби со повеќе улоги, документи и одлуки.

## Што е имплементирано

- Најава со корисници од база (без hardcoded admin)
- Студентска најава преку Microsoft Entra (OIDC Authorization Code flow)
- Модел на база според ERD:
  - `roles` (`roleId`, `tip`) каде `tip` е: `Admin`, `Sluzhba`, `Prodekan`, `Arhiva`
  - `users` (`userId`, `roleId`, `ime`, `prezime`, `email`, `password`, `provider`, `providerId`)
  - `students` (`userId`, `brIndeks`, `smer`) како подкласа на `users`
  - `molbi` (`molbaId`, `userId`, `status`, `datum`, `naslov`, `semestar`, `description`, `feedback`, `arhivski_broj`, `url_path`)
- Улоги:
  - `student`
  - `admin` (глобален пристап + преземање студентски акаунт)
  - `studentska_sluzhba`
  - `prodekan`
  - `arhiva`
- Поднесување молба со:
  - наслов
  - избор на семестар (`Зимски` или `Летен`)
  - опис
  - задолжителен PDF документ
- Архива workflow:
  - нова молба прво оди во архива
  - архивата внесува уникатно `arhivski_broj`
  - дури потоа молбата станува видлива за `studentska_sluzhba` и `prodekan`
- Детали на молба:
  - симнување студентски документ
  - промена статус (служба/продекан/админ)
- Архива role:
  - преглед + download документи
  - нема право на промена статус
- PostgreSQL конфигурација
- Хибридна автентикација:
  - `student` -> Microsoft Entra
  - `admin`, `studentska_sluzhba`, `prodekan`, `arhiva` -> локален email/password

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

Пример `.env` (Entra дел):

```env
ENTRA_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ENTRA_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
ENTRA_CLIENT_SECRET=your-client-secret
ENTRA_REDIRECT_URI=http://localhost:3000/auth/microsoft/callback
ENTRA_POST_LOGOUT_REDIRECT_URI=http://localhost:3000/login
ENTRA_ALLOWED_EMAIL_DOMAINS=feit.ukim.edu.mk,studenti.feit.ukim.edu.mk
```

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

- `marko.petrovski@student.mk` (student, најавата е преку Microsoft Entra)
- `admin@university.mk / password123` (admin)
- `sluzhba@university.mk / password123` (studentska_sluzhba)
- `prodekan@university.mk / password123` (prodekan)
- `arhiva@university.mk / password123` (arhiva)

## Microsoft Entra App Registration (локално)

1. Entra admin center -> App registrations -> New registration.
2. Name: пример `PraksaMolbi Local`.
3. Supported account types: `Accounts in this organizational directory only`.
4. Redirect URI:
  - Platform: `Web`
  - URI: `http://localhost:3000/auth/microsoft/callback`
5. Register.
6. Во app overview копирај:
  - `Application (client) ID` -> `ENTRA_CLIENT_ID`
  - `Directory (tenant) ID` -> `ENTRA_TENANT_ID`
7. Certificates & secrets -> New client secret -> копирај ја вредноста во `ENTRA_CLIENT_SECRET`.
8. Authentication:
  - Потврди дека `Web redirect URI` е точно поставен.
  - ID tokens не се задолжителни за овој backend flow.
9. Token configuration (опционално): додади `email` optional claim ако не се враќа.
10. API permissions:
  - `openid`
  - `profile`
  - `email`
11. Admin consent ако tenant policy го бара тоа.

По ова пушти:

```bash
npm run seed
npm start
```

## Upload ограничувања

- За креирање нова молба: задолжителен е 1 PDF
- Максимална големина: 15MB