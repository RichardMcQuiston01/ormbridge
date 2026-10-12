import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type { Shipment } from './shipment.js';

export class Item extends Model<
  InferAttributes<Item>,
  InferCreationAttributes<Item>
> {
  declare id: CreationOptional<number>;
  declare first_name: string;
  declare last_name: string;
  declare full_name: string;
  declare quantity: CreationOptional<number>;
  declare total_cents: number;
  declare tags: CreationOptional<string[]>;
  declare grid: CreationOptional<number[][] | null>;
  declare kinds: CreationOptional<('tool' | 'toy')[]>;
  declare attributes: CreationOptional<Record<string, string | null>>;
  declare stock_range: CreationOptional<unknown | null>;
  declare big_range: CreationOptional<unknown | null>;
  declare price_range: CreationOptional<unknown | null>;
  declare available: CreationOptional<unknown | null>;
  declare valid_during: CreationOptional<unknown | null>;
  declare last_ip: CreationOptional<string | null>;
  declare legacy_ip: CreationOptional<string | null>;
  declare shelf_life: CreationOptional<string | null>;
  declare source_path: CreationOptional<string | null>;
  declare manual: CreationOptional<string | null>;
  declare photo: CreationOptional<string | null>;
  declare small_count: CreationOptional<number>;
  declare tiny_count: CreationOptional<number>;
  declare is_active: CreationOptional<boolean>;
  declare stocked_at: CreationOptional<Date>;
  declare priority: CreationOptional<number>;
  declare note: CreationOptional<string>;

  declare shipments?: NonAttribute<Shipment[]>;
  declare other_shipments?: NonAttribute<Shipment[]>;

  static initModel(sequelize: Sequelize): typeof Item {
    Item.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        first_name: { type: DataTypes.STRING(40), allowNull: false },
        last_name: { type: DataTypes.STRING(40), allowNull: false },
        full_name: { type: DataTypes.STRING(81), allowNull: false },
        quantity: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 1,
        },
        total_cents: { type: DataTypes.INTEGER, allowNull: false },
        tags: {
          type: DataTypes.ARRAY(DataTypes.STRING(20)),
          allowNull: false,
          defaultValue: [],
        },
        grid: DataTypes.ARRAY(DataTypes.ARRAY(DataTypes.INTEGER)),
        kinds: {
          type: DataTypes.ARRAY(DataTypes.ENUM('tool', 'toy')),
          allowNull: false,
          defaultValue: '[]',
        },
        attributes: {
          type: DataTypes.HSTORE,
          allowNull: false,
          defaultValue: {},
        },
        stock_range: DataTypes.RANGE(DataTypes.INTEGER),
        big_range: DataTypes.RANGE(DataTypes.BIGINT),
        price_range: DataTypes.RANGE(DataTypes.DECIMAL),
        available: DataTypes.RANGE(DataTypes.DATEONLY),
        valid_during: DataTypes.RANGE(DataTypes.DATE),
        last_ip: DataTypes.INET,
        legacy_ip: { type: DataTypes.INET, unique: true },
        shelf_life: DataTypes.BIGINT,
        source_path: DataTypes.STRING(100),
        manual: DataTypes.STRING(100),
        photo: DataTypes.STRING(100),
        small_count: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        tiny_count: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        is_active: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        stocked_at: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: DataTypes.NOW,
        },
        priority: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 5,
        },
        note: {
          type: DataTypes.STRING(20),
          allowNull: false,
          defaultValue: 'none',
        },
      },
      {
        sequelize,
        modelName: 'Item',
        tableName: 'blog_item',
        timestamps: false,
      }
    );
    return Item;
  }
}
