import type { Sequelize } from 'sequelize';
import { Customer } from './customer.js';
import { Order } from './order.js';
import { OrderItem } from './orderItem.js';
import { Product } from './product.js';
import { Label } from './label.js';
import { Comment } from './comment.js';

export { Customer, Order, OrderItem, Product, Label, Comment };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  Customer.initModel(sequelize);
  Order.initModel(sequelize);
  OrderItem.initModel(sequelize);
  Product.initModel(sequelize);
  Label.initModel(sequelize);
  Comment.initModel(sequelize);

  Order.belongsTo(Customer, {
    as: 'customer',
    foreignKey: 'customerId',
    onDelete: 'RESTRICT',
  });
  Customer.hasMany(Order, {
    as: 'orders',
    foreignKey: 'customerId',
    onDelete: 'RESTRICT',
  });

  Order.belongsToMany(Label, {
    as: 'labels',
    through: 'order_labels',
    foreignKey: 'order_id',
    otherKey: 'label_id',
    timestamps: false,
  });

  OrderItem.belongsTo(Product, {
    as: 'product',
    foreignKey: 'productSku',
    onDelete: 'NO ACTION',
  });

  OrderItem.belongsTo(Order, {
    as: 'order',
    foreignKey: 'orderId',
    onDelete: 'NO ACTION',
  });
  Order.hasMany(OrderItem, {
    as: 'items',
    foreignKey: 'orderId',
    onDelete: 'NO ACTION',
  });

  Product.belongsToMany(Product, {
    as: 'similar',
    through: 'product_similar',
    foreignKey: 'from_product_id',
    otherKey: 'to_product_id',
    timestamps: false,
  });

  return { Customer, Order, OrderItem, Product, Label, Comment };
}

export type Models = ReturnType<typeof initModels>;
