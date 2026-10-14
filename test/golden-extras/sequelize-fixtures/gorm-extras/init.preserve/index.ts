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
    foreignKey: 'customer_id',
    onDelete: 'RESTRICT',
  });
  Customer.hasMany(Order, {
    as: 'orders',
    foreignKey: 'customer_id',
    onDelete: 'RESTRICT',
  });

  Order.belongsToMany(Label, {
    as: 'labels',
    through: 'shop_orders_labels',
    foreignKey: 'order_id',
    otherKey: 'label_id',
    timestamps: false,
  });

  OrderItem.belongsTo(Product, {
    as: 'product',
    foreignKey: 'product_sku',
    onDelete: 'NO ACTION',
  });

  OrderItem.belongsTo(Order, {
    as: 'order',
    foreignKey: 'order_id',
    onDelete: 'NO ACTION',
  });
  Order.hasMany(OrderItem, {
    as: 'items',
    foreignKey: 'order_id',
    onDelete: 'NO ACTION',
  });

  Product.belongsToMany(Product, {
    as: 'similar',
    through: 'products_similar',
    foreignKey: 'from_product_id',
    otherKey: 'to_product_id',
    timestamps: false,
  });

  return { Customer, Order, OrderItem, Product, Label, Comment };
}

export type Models = ReturnType<typeof initModels>;
