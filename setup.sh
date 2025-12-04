#!/bin/bash
set -e  # Exit on error

echo "🚀 AI Town Automated Setup"
echo "=========================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

APP_URL="http://localhost:5173/ai-town"

wait_for_docker() {
    local max_attempts=${1:-40}
    local attempt=1
    while [ $attempt -le $max_attempts ]; do
        if docker ps > /dev/null 2>&1; then
            # Double-check by running docker info
            if docker info > /dev/null 2>&1; then
                return 0
            fi
        fi
        if [ $((attempt % 5)) -eq 0 ]; then
            print_info "Still waiting for Docker... (attempt $attempt/$max_attempts)"
        fi
        sleep 2
        attempt=$((attempt + 1))
    done
    return 1
}

# Function to print status messages
print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${YELLOW}ℹ${NC} $1"
}

# Step 0: Kill all existing Docker containers and services
echo "0️⃣  Cleaning up existing Docker containers and services..."
print_info "Stopping all running Docker containers..."
docker ps -q | xargs -r docker stop > /dev/null 2>&1 || true
print_info "Removing all Docker containers..."
docker ps -a -q | xargs -r docker rm > /dev/null 2>&1 || true
print_info "Stopping Docker Compose services..."
cd "$(dirname "$0")" && docker-compose down > /dev/null 2>&1 || true
print_status "All Docker processes cleaned up"
echo ""

# Step 1: Check if Docker is running
echo "1️⃣  Checking Docker..."
if ! docker ps > /dev/null 2>&1; then
    print_info "Docker Desktop is not running. Starting it now..."
    open -a Docker
    echo "   Waiting for Docker to start..."
    if wait_for_docker; then
        print_status "Docker is now running"
    else
        print_error "Docker failed to start within the expected time"
        echo "   Please start Docker Desktop manually and run this script again."
        exit 1
    fi
else
    print_status "Docker is already running"
fi
echo ""

# Step 2: Kill old processes
echo "2️⃣  Cleaning up old processes..."
pkill -f "node" 2>/dev/null || true
pkill -f "npm" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
pkill -f "convex" 2>/dev/null || true

# Free ports
for port in 5173 5174 5175 5176 3210 3211; do
    lsof -ti:$port | xargs kill -9 2>/dev/null || true
done
print_status "Old processes cleaned up"
echo ""

# Step 3: Stop old containers and clean database
echo "3️⃣  Stopping old Docker containers..."
docker compose down 2>/dev/null || true

# Remove any running backend containers that might hold the volume
docker rm -f ai-town-backend-1 2>/dev/null || true

# Delete the database volume to start fresh
if docker volume ls | grep -q "ai-town_data"; then
    print_info "Deleting old database volume for fresh start..."
    docker volume rm ai-town_data 2>/dev/null || true
    print_status "Database volume deleted"
else
    print_status "No existing database volume found"
fi

print_status "Old containers stopped"
echo ""

# Step 4: Verify Docker is ready after stopping containers
echo "4️⃣  Verifying Docker is ready..."
print_info "Waiting for Docker daemon to stabilize..."
sleep 2

# Check if Docker Desktop is running, start it if not
if ! docker ps > /dev/null 2>&1; then
    print_info "Docker Desktop not detected, attempting to start..."
    open -a Docker 2>/dev/null || true
    sleep 5
fi

if ! wait_for_docker 60; then
    print_error "Docker daemon is not available after waiting"
    print_info "Please ensure Docker Desktop is running and try again"
    print_info "You can start Docker Desktop manually and rerun this script"
    exit 1
fi
print_status "Docker is ready"
echo ""

# Step 5: Start Docker Compose services
echo "5️⃣  Starting Docker services..."

MAX_COMPOSE_ATTEMPTS=3
COMPOSE_SUCCESS=0
for attempt in $(seq 1 $MAX_COMPOSE_ATTEMPTS); do
    set +e
    docker compose up -d
    STATUS=$?
    set -e
    if [ $STATUS -eq 0 ]; then
        COMPOSE_SUCCESS=1
        break
    fi
    print_info "docker compose up failed (attempt ${attempt}/${MAX_COMPOSE_ATTEMPTS}). Retrying in 5s..."
    sleep 5
    if ! wait_for_docker; then
        print_error "Docker daemon is not responding during retries"
        exit 1
    fi
done

if [ $COMPOSE_SUCCESS -eq 1 ]; then
    print_status "Docker services started"
else
    print_error "Failed to start Docker services after ${MAX_COMPOSE_ATTEMPTS} attempts"
    exit 1
fi
echo ""

# Step 6: Wait for backend to be healthy
echo "6️⃣  Waiting for backend to be ready..."
# Backend needs time to bootstrap (60-90s), and may restart due to memory pressure
# Wait up to 120 seconds, checking every 2 seconds
for i in {1..60}; do
    # Check if container is running first
    if ! docker ps --format '{{.Names}}' | grep -q '^ai-town-backend-1$'; then
        sleep 2
        continue
    fi
    # Then check if endpoint responds
    if curl -f http://localhost:3210/version > /dev/null 2>&1; then
        print_status "Backend is ready"
        break
    fi
    if [ $i -eq 60 ]; then
        print_error "Backend failed to start after 120 seconds"
        print_error "Check logs with: docker logs ai-town-backend-1"
        exit 1
    fi
    sleep 2
done
echo ""

# Step 7: Generate Convex admin key
echo "7️⃣  Generating Convex admin key..."
ADMIN_KEY=$(docker compose exec -T backend ./generate_admin_key.sh 2>/dev/null | tail -n 1)
if [ -z "$ADMIN_KEY" ]; then
    print_error "Failed to generate admin key"
    exit 1
fi
print_status "Admin key generated"
echo ""

# Step 8: Create .env.local
echo "8️⃣  Creating .env.local configuration..."
cat > .env.local << EOF
CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY"
CONVEX_SELF_HOSTED_URL="http://127.0.0.1:3210"
VITE_CONVEX_URL="http://127.0.0.1:3210"
VITE_ELEVENLABS_API_KEY=sk_4b09a2b14482b6b6757c35d29f355c2b3a9189083739fd4d
EOF
print_status ".env.local created"
echo ""

# Step 9: Check/start Ollama
echo "9️⃣  Checking Ollama service..."
if ! curl -s http://localhost:11434 > /dev/null 2>&1; then
    print_info "Starting Ollama..."
    pkill -9 ollama 2>/dev/null || true
    sleep 2
    ollama serve > /tmp/ollama.log 2>&1 &
    sleep 3
fi

# Verify Ollama is running
if curl -s http://localhost:11434 | grep -q "Ollama is running"; then
    print_status "Ollama is running"
else
    print_error "Failed to start Ollama"
    exit 1
fi
echo ""

# Step 10: Pull required models
echo "🔟 Pulling required Ollama models..."
print_info "Pulling dolphin-llama3:8b (this may take a few minutes)..."
ollama pull dolphin-llama3:8b > /dev/null 2>&1
print_status "dolphin-llama3:8b model ready"

print_info "Pulling mxbai-embed-large..."
ollama pull mxbai-embed-large > /dev/null 2>&1
print_status "mxbai-embed-large model ready"
echo ""

# Step 11: Verify Docker can reach Ollama
echo "1️⃣1️⃣  Verifying Docker backend can reach Ollama..."
if docker compose exec -T backend curl -s http://host.docker.internal:11434 2>/dev/null | grep -q "Ollama is running"; then
    print_status "Backend can connect to Ollama"
else
    print_error "Backend cannot connect to Ollama"
    exit 1
fi
echo ""

# Step 12: Deploy Convex functions
echo "1️⃣2️⃣  Deploying Convex functions..."

# Verify backend is ready
if ! curl -f http://localhost:3210/version > /dev/null 2>&1; then
    print_error "Backend not responding. Waiting 10s and retrying..."
    sleep 10
    if ! curl -f http://localhost:3210/version > /dev/null 2>&1; then
        print_error "Backend still not responding. Check: docker logs ai-town-backend-1"
        exit 1
    fi
fi

# Deploy with output visible (not hidden)
print_info "Deploying to http://127.0.0.1:3210..."
if npx convex deploy --typecheck=disable -y; then
    print_status "Convex functions deployed successfully"
else
    DEPLOY_EXIT=$?
    print_error "Deployment failed (exit code: $DEPLOY_EXIT)"
    print_info "If this persists, try manually: npx convex dev"
    exit 1
fi
echo ""

# Step 13: Initialize world and clear old story data
echo "1️⃣3️⃣  Initializing world with characters and clearing old data..."

# Initialize/reinitialize the world (this creates a fresh world or regenerates characters)
print_info "Initializing/Reinitializing world..."
npx convex run init:default > /dev/null 2>&1
print_status "World initialized"

# Wait a moment for world to be fully created
sleep 3

# Now get the world ID and clear ALL old data
print_info "Clearing ALL old data (conversations, plots, passages, memories, character descriptions)..."
WORLD_STATUS=$(npx convex run world:defaultWorldStatus 2>&1 || echo '{}')
WORLD_ID=$(echo "$WORLD_STATUS" | grep -o '"worldId":"[^"]*"' | cut -d'"' -f4 || echo "")

if [ -z "$WORLD_ID" ] || [ "$WORLD_ID" = "null" ] || [ "$WORLD_ID" = "" ]; then
    print_info "⚠️  Warning: Could not extract world ID. Status output:"
    echo "$WORLD_STATUS" | head -3 || true
    print_info "Skipping data cleanup - world may not be initialized yet"
else
    print_info "Found world ID: $WORLD_ID"
    print_info "Calling resetWorldStory to clear all old data..."
    
    # Call the reset function and capture output
    RESET_RESULT=$(npx convex run worldStory:resetWorldStory "{\"worldId\":\"$WORLD_ID\"}" 2>&1)
    RESET_EXIT_CODE=$?
    
    if [ $RESET_EXIT_CODE -eq 0 ]; then
        # Check if the result contains success indicators
        if echo "$RESET_RESULT" | grep -qi '"success":true\|successfully\|Cleared\|Reset'; then
            print_status "✓ All old story data cleared successfully"
            # Try to extract deletion counts from the message
            if echo "$RESET_RESULT" | grep -q "Cleared"; then
                DELETED=$(echo "$RESET_RESULT" | grep -o "Cleared [0-9]*" | head -1 || echo "")
                [ -n "$DELETED" ] && echo "$DELETED"
            fi
        else
            print_info "Reset executed. Response:"
            echo "$RESET_RESULT" | head -5 || true
        fi
    else
        print_info "⚠️  Reset function returned exit code $RESET_EXIT_CODE. Output:"
        echo "$RESET_RESULT" | head -5 || true
    fi
fi
print_status "World initialized and cleaned"
echo ""

# Step 14: Kick the engine (optional - engine starts automatically after init)
echo "1️⃣4️⃣  Starting the game engine..."
if npx convex run testing:kick > /dev/null 2>&1; then
    print_status "Game engine kicked"
else
    print_status "Game engine will start automatically"
fi
echo ""

# Step 15: Verify Docker backend is still running
echo "1️⃣5️⃣  Verifying Docker backend is running..."
if docker ps | grep -q "ai-town-backend-1"; then
    if curl -f http://localhost:3210/version > /dev/null 2>&1; then
        print_status "Docker backend is healthy"
    else
        print_error "Docker backend container is running but not responding"
        exit 1
    fi
else
    print_error "Docker backend container is not running"
    echo "   Try running: docker compose up -d"
    exit 1
fi
echo ""

# Step 16: Start frontend
echo "1️⃣6️⃣  Starting frontend development server..."
npm run dev:frontend > /tmp/frontend.log 2>&1 &
FRONTEND_PID=$!
sleep 3

print_status "Frontend started (PID: $FRONTEND_PID)"
print_info "Backend is running in Docker (see: docker logs ai-town-backend-1)"
echo ""

# Step 17: Wait for frontend to be ready
echo "1️⃣7️⃣  Waiting for frontend to be ready..."
FRONTEND_READY=0
for i in {1..20}; do
    if curl -s http://localhost:5173/ai-town > /dev/null 2>&1; then
        print_status "Frontend is ready"
        FRONTEND_READY=1
        break
    fi
    if [ $i -eq 20 ]; then
        print_error "Frontend failed to start"
        exit 1
    fi
    sleep 1
done
echo ""

if [ "$FRONTEND_READY" -eq 1 ]; then
    print_info "Launching ${APP_URL} in your default browser..."
    if command -v open > /dev/null 2>&1; then
        if ! open "$APP_URL" > /dev/null 2>&1; then
            print_info "Couldn't auto-open. Please visit: ${APP_URL}"
        fi
    else
        print_info "Open this URL in your browser: ${APP_URL}"
    fi
    echo ""
fi

# Step 18: Wait for agents to start conversing
echo "1️⃣8️⃣  Waiting for agents to start conversing..."
print_info "This may take 30-60 seconds for the first conversation..."

# Function to check for messages via Convex CLI
check_messages() {
    # Use curl to check the dashboard API for message count
    # This is more reliable than running a Convex function
    RESPONSE=$(curl -s "http://localhost:3210/api/query?format=json" \
        -H "Content-Type: application/json" \
        -d '{"path":"messages:list","args":{}}' 2>/dev/null || echo '{"page":[]}')
    
    MESSAGE_COUNT=$(echo "$RESPONSE" | grep -o '"text"' | wc -l | tr -d ' ')
    echo $MESSAGE_COUNT
}

# Wait up to 90 seconds for messages to appear
for i in {1..18}; do
    sleep 5
    MSG_COUNT=$(check_messages)
    if [ "$MSG_COUNT" -gt "0" ]; then
        print_status "Agents are conversing! ($MSG_COUNT messages found)"
        break
    fi
    if [ $i -eq 18 ]; then
        print_info "No messages detected yet, but the system is running."
        print_info "Agents may take a few minutes to start their first conversation."
    fi
done
echo ""

# Final success message
echo "=========================="
echo -e "${GREEN}✨ Setup Complete!${NC}"
echo "=========================="
echo ""
echo "🌐 Frontend:  http://localhost:5173/ai-town"
echo "🗄️  Backend:   http://localhost:3210"
echo "📊 Dashboard: http://localhost:6791"
echo ""
echo "The AI agents are now active and will begin conversing."
echo "Watch them interact in the game world!"
echo ""
echo "Logs:"
echo "  - Frontend: /tmp/frontend.log"
echo "  - Backend:  /tmp/backend.log"
echo "  - Ollama:   /tmp/ollama.log"
echo ""
echo "=========================="
print_info "Starting to tail backend logs (conversations will appear here)..."
print_info "Press Ctrl+C to stop tailing (containers will keep running)"
echo ""
# Tail Docker backend logs in real-time
# This will show all logs including conversation messages with 💬 emoji
docker logs -f ai-town-backend-1

