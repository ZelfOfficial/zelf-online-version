#!/bin/bash

# Tags API Testing Setup Script
# This script helps set up the testing environment for the Tags API

echo "🚀 Setting up Tags API Testing Environment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    print_error "Node.js is not installed. Please install Node.js first."
    exit 1
fi

print_status "Node.js is installed"

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    print_error "npm is not installed. Please install npm first."
    exit 1
fi

print_status "npm is installed"

# Check if the server is running
print_info "Checking if the server is running..."

if curl -s http://localhost:3000/health > /dev/null 2>&1; then
    print_status "Server is running on http://localhost:3000"
else
    print_warning "Server is not running on http://localhost:3000"
    print_info "Please start your server first:"
    echo "  cd /path/to/your/zelf/project"
    echo "  npm start"
    echo ""
fi

# Create Postman collection directory if it doesn't exist
mkdir -p postman

print_status "Postman collection files created:"
echo "  📁 postman/Tags-API-Collection.json"
echo "  📁 postman/Tags-API-Environment.json"
echo "  📁 postman/test-data.json"
echo "  📁 postman/README.md"
echo "  📁 postman/setup-testing.sh"

echo ""
print_info "Next steps:"
echo "1. Import the collection into Postman:"
echo "   - Open Postman"
echo "   - Click Import → Upload Files"
echo "   - Select: postman/Tags-API-Collection.json"
echo "   - Click Import"
echo ""
echo "2. Import the environment:"
echo "   - In Postman, click Environments"
echo "   - Click Import"
echo "   - Select: postman/Tags-API-Environment.json"
echo "   - Click Import"
echo ""
echo "3. Set your JWT token:"
echo "   - Select the 'Tags API Environment'"
echo "   - Set the 'jwt_token' variable with your actual JWT token"
echo ""
echo "4. Start testing:"
echo "   - Select the 'Tags API - Multi-Domain System' collection"
echo "   - Choose a request to test"
echo "   - Click Send"
echo ""

print_info "Available test scenarios:"
echo "  🔍 Domain Management - Test domain configurations"
echo "  🔍 Tag Search & Discovery - Test search functionality"
echo "  🔍 Tag Operations - Test CRUD operations"
echo "  🔍 Payment Operations - Test payment logic"
echo "  🔍 My Tags - Test user operations"
echo "  🔍 System Health - Test monitoring"
echo "  🔍 Advanced Operations - Test offline and special features"
echo ""

print_info "Supported domains for testing:"
echo "  🆓 .zelf (Free)"
echo "  💰 .avax ($1.00)"
echo "  💰 .btc ($0.50)"
echo "  💰 .tech ($0.75)"
echo ""

print_info "Test data is available in postman/test-data.json"
print_info "Documentation is available in postman/README.md"

echo ""
print_status "Setup complete! Happy testing! 🚀"
