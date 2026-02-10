class ProductionScheduleSocketService {
  constructor(socket) {
    this.socket = socket;
    this.listeners = new Map();
    this.subscribedWorkOrders = new Set();
    this.cache = {
      schedules: [],
      manufacturingOrders: [],
      lastUpdated: null
    };
  }

  // Subscribe to work order updates
  subscribeToWorkOrder(workOrderId) {
    if (this.subscribedWorkOrders.has(workOrderId)) return;
    
    this.socket.emit('join-workorder', workOrderId);
    this.subscribedWorkOrders.add(workOrderId);
    console.log(`📡 Subscribed to work order: ${workOrderId}`);
  }

  // Unsubscribe from work order
  unsubscribeFromWorkOrder(workOrderId) {
    this.socket.emit('leave-workorder', workOrderId);
    this.subscribedWorkOrders.delete(workOrderId);
    console.log(`📡 Unsubscribed from work order: ${workOrderId}`);
  }

  // Subscribe to schedule updates
  subscribeToSchedule(dateRange) {
    this.socket.emit('join-schedule-room', dateRange);
    console.log(`📡 Subscribed to schedule updates for range:`, dateRange);
  }

  // Listen for schedule updates
  onScheduleUpdate(callback) {
    const handler = (data) => {
      // Update cache
      this.cache.schedules = data.schedules || [];
      this.cache.lastUpdated = new Date();
      callback(data);
    };
    
    this.socket.on('schedule-updated', handler);
    this.listeners.set('schedule-updated', handler);
  }

  // Listen for manufacturing order updates
  onManufacturingOrderUpdate(callback) {
    const handler = (data) => {
      // Update cache
      this.cache.manufacturingOrders = data.manufacturingOrders || [];
      this.cache.lastUpdated = new Date();
      callback(data);
    };
    
    this.socket.on('manufacturing-order-updated', handler);
    this.listeners.set('manufacturing-order-updated', handler);
  }

  // Listen for work order updates
  onWorkOrderUpdate(callback) {
    const handler = (data) => {
      callback(data);
    };
    
    this.socket.on('work-order-updated', handler);
    this.listeners.set('work-order-updated', handler);
  }

  // Get cached data (if available and fresh)
  getCachedData(type, maxAgeMinutes = 5) {
    if (!this.cache.lastUpdated) return null;
    
    const age = (Date.now() - this.cache.lastUpdated.getTime()) / (1000 * 60);
    if (age > maxAgeMinutes) return null;
    
    return type === 'schedules' 
      ? this.cache.schedules 
      : this.cache.manufacturingOrders;
  }

  // Clear all listeners
  cleanup() {
    this.listeners.forEach((handler, event) => {
      this.socket.off(event, handler);
    });
    this.listeners.clear();
    this.subscribedWorkOrders.clear();
  }
}

export default ProductionScheduleSocketService;