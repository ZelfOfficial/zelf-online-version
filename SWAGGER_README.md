# Zelf Wallet API Documentation

This document explains how to use and extend the Swagger API documentation for the Zelf Wallet backend.

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Server

```bash
npm start
```

### 3. Access Swagger UI

Once the server is running, you can access the interactive API documentation at:

-   **Development**: http://localhost:${PORT}/swagger (where PORT is from your environment or config)
-   **Production**: https://v4.zelf.world/swagger

## 📚 API Documentation Features

### Interactive Documentation

-   **Try it out**: Test endpoints directly from the browser
-   **Authentication**: Built-in JWT token support
-   **Request/Response Examples**: Pre-filled examples for all endpoints
-   **Schema Validation**: Automatic request validation
-   **Error Handling**: Comprehensive error responses

### Organized by Tags

The API is organized into logical groups:

-   **Authentication**: Login and token management
-   **Zero-Knowledge Proofs**: ZKP generation and verification
-   **Public**: Endpoints that don't require authentication
-   **Protected**: Endpoints that require JWT authentication
-   **Client**: Client management operations
-   **IPFS**: IPFS storage and retrieval
-   **Mail**: Email service operations
-   **SuperAdmin**: Super admin management
-   **Session**: Session management
-   **Subscribers**: Subscriber operations
-   **Wallet**: Wallet management
-   **Blockchain**: Blockchain integrations (Avalanche, Bitcoin, Cardano, etc.)
-   **Data Analytics**: Analytics and reporting
-   **Rewards**: Rewards and incentives
-   **Zelf Services**: Zelf-specific services

## 🔧 Configuration

### Swagger Configuration (`swagger.js`)

The main configuration file defines:

-   **API Information**: Title, version, description, contact info
-   **Servers**: Development and production URLs
-   **Security Schemes**: JWT Bearer token authentication
-   **Global Schemas**: Reusable data models
-   **Tags**: API endpoint categorization

### Environment Variables

Make sure your `.env` file includes:

```env
JWT_SECRET=your_jwt_secret_here
PORT=3002
```

## 📝 Adding New Endpoints

### 1. Basic Endpoint Documentation

```javascript
/**
 * @swagger
 * /api/example:
 *   get:
 *     summary: Example endpoint
 *     description: This is an example endpoint
 *     tags: [Example]
 *     responses:
 *       200:
 *         description: Success response
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Success"
 */
router.get("/api/example", async (ctx) => {
    ctx.body = { message: "Success" };
});
```

### 2. Protected Endpoints

```javascript
/**
 * @swagger
 * /api/protected-example:
 *   get:
 *     summary: Protected example endpoint
 *     description: This endpoint requires authentication
 *     tags: [Protected]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Success response
 *       401:
 *         description: Unauthorized
 */
router.get("/api/protected-example", async (ctx) => {
    ctx.body = { message: "Protected endpoint" };
});
```

### 3. Request Body Documentation

```javascript
/**
 * @swagger
 * components:
 *   schemas:
 *     CreateExampleRequest:
 *       type: object
 *       required: [name, email]
 *       properties:
 *         name:
 *           type: string
 *           description: User name
 *           example: "John Doe"
 *         email:
 *           type: string
 *           format: email
 *           description: User email
 *           example: "john@example.com"
 */

/**
 * @swagger
 * /api/example:
 *   post:
 *     summary: Create example
 *     description: Create a new example
 *     tags: [Example]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateExampleRequest'
 *     responses:
 *       201:
 *         description: Created successfully
 */
router.post("/api/example", async (ctx) => {
    const { name, email } = ctx.request.body;
    ctx.status = 201;
    ctx.body = { id: "new-id", name, email };
});
```

### 4. Query Parameters

```javascript
/**
 * @swagger
 * /api/example:
 *   get:
 *     summary: Get examples with pagination
 *     description: Retrieve examples with pagination support
 *     tags: [Example]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Items per page
 *     responses:
 *       200:
 *         description: List of examples
 */
```

### 5. Path Parameters

```javascript
/**
 * @swagger
 * /api/example/{id}:
 *   get:
 *     summary: Get example by ID
 *     description: Retrieve a specific example
 *     tags: [Example]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Example ID
 *     responses:
 *       200:
 *         description: Example found
 *       404:
 *         description: Example not found
 */
```

## 🔐 Authentication

### Getting a JWT Token

1. Use the `/login` endpoint with username and password
2. Copy the returned token
3. In Swagger UI, click "Authorize" button
4. Enter: `Bearer YOUR_TOKEN_HERE`
5. Click "Authorize"

### Testing Protected Endpoints

Once authorized, you can test any protected endpoint directly from the Swagger UI.

## 🎨 Customizing the UI

### Custom CSS (Optional)

You can customize the Swagger UI appearance by adding custom CSS:

```javascript
// In server.js, after swagger setup
app.use(async (ctx, next) => {
    if (ctx.path === "/swagger") {
        // Add custom CSS
        ctx.body = ctx.body.replace("</head>", "<style>.swagger-ui .topbar { display: none }</style></head>");
    }
    await next();
});
```

### Custom Branding

Update the `swagger.js` configuration:

```javascript
info: {
  title: 'Zelf Wallet API',
  version: '1.0.0',
  description: 'Your custom description',
  contact: {
    name: 'Your Support Team',
    email: 'support@yourcompany.com',
    url: 'https://yourcompany.com'
  }
}
```

## 🧪 Testing

### Manual Testing

1. Start the server: `npm start`
2. Open http://localhost:3002/swagger
3. Try the `/login` endpoint to get a token
4. Authorize with the token
5. Test protected endpoints

### Automated Testing

The Swagger specification can be used for automated testing:

```javascript
// Example using supertest
const request = require("supertest");
const app = require("./server");

describe("API Tests", () => {
    it("should login successfully", async () => {
        const response = await request(app).post("/login").send({ username: "user", password: "password" });

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty("token");
    });
});
```

## 📊 Monitoring and Analytics

### API Usage Tracking

You can track API usage by adding middleware:

```javascript
// Add to server.js
app.use(async (ctx, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;

    console.log(`${ctx.method} ${ctx.url} - ${ms}ms`);
});
```

### Error Tracking

The Swagger validation middleware will automatically validate requests and return detailed error messages.

## 🚀 Deployment

### Production Considerations

1. **Security**: Ensure JWT_SECRET is properly set
2. **CORS**: Configure CORS for your domain
3. **Rate Limiting**: Consider adding rate limiting middleware
4. **Logging**: Implement proper logging for production
5. **Monitoring**: Set up monitoring and alerting

### Environment Variables

```env
NODE_ENV=production
JWT_SECRET=your_secure_jwt_secret
PORT=3002
MONGODB_URI=your_mongodb_connection_string
```

## 🤝 Contributing

When adding new endpoints:

1. Follow the existing documentation patterns
2. Include comprehensive examples
3. Add proper error responses
4. Use appropriate tags for organization
5. Test the documentation in Swagger UI

## 📞 Support

For questions or issues with the API documentation:

-   Check the Swagger UI for interactive examples
-   Review the endpoint documentation
-   Contact the development team

---

**Happy API Testing! 🎉**
