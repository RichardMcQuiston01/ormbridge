import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
} from '@sequelize/core';
import {
  Attribute,
  AutoIncrement,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
} from '@sequelize/core/decorators-legacy';
import type { Shipment } from './shipment.js';

@Table({ tableName: 'blog_item', timestamps: false })
export class Item extends Model<
  InferAttributes<Item>,
  InferCreationAttributes<Item>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(40))
  @NotNull
  declare first_name: string;

  @Attribute(DataTypes.STRING(40))
  @NotNull
  declare last_name: string;

  @Attribute(DataTypes.STRING(81))
  @NotNull
  declare full_name: string;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Default(1)
  declare quantity: CreationOptional<number>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare total_cents: number;

  @Attribute(DataTypes.ARRAY(DataTypes.STRING(20)))
  @NotNull
  @Default([])
  declare tags: CreationOptional<string[]>;

  @Attribute(DataTypes.ARRAY(DataTypes.ARRAY(DataTypes.INTEGER)))
  declare grid: CreationOptional<number[][] | null>;

  @Attribute(DataTypes.ARRAY(DataTypes.ENUM('tool', 'toy')))
  @NotNull
  @Default([])
  declare kinds: CreationOptional<('tool' | 'toy')[]>;

  @Attribute(DataTypes.HSTORE)
  @NotNull
  @Default({})
  declare attributes: CreationOptional<Record<string, string | null>>;

  @Attribute(DataTypes.RANGE(DataTypes.INTEGER))
  declare stock_range: CreationOptional<unknown | null>;

  @Attribute(DataTypes.RANGE(DataTypes.BIGINT))
  declare big_range: CreationOptional<unknown | null>;

  @Attribute(DataTypes.RANGE(DataTypes.DECIMAL))
  declare price_range: CreationOptional<unknown | null>;

  @Attribute(DataTypes.RANGE(DataTypes.DATEONLY))
  declare available: CreationOptional<unknown | null>;

  @Attribute(DataTypes.RANGE(DataTypes.DATE))
  declare valid_during: CreationOptional<unknown | null>;

  @Attribute(DataTypes.INET)
  declare last_ip: CreationOptional<string | null>;

  @Attribute(DataTypes.INET)
  @Unique
  declare legacy_ip: CreationOptional<string | null>;

  @Attribute(DataTypes.BIGINT)
  declare shelf_life: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(100))
  declare source_path: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(100))
  declare manual: CreationOptional<string | null>;

  @Attribute(DataTypes.STRING(100))
  declare photo: CreationOptional<string | null>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Default(0)
  declare small_count: CreationOptional<number>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Default(0)
  declare tiny_count: CreationOptional<number>;

  @Attribute(DataTypes.BOOLEAN)
  @NotNull
  @Default(true)
  declare is_active: CreationOptional<boolean>;

  @Attribute(DataTypes.DATE)
  @NotNull
  @Default(DataTypes.NOW)
  declare stocked_at: CreationOptional<Date>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Default(5)
  declare priority: CreationOptional<number>;

  @Attribute(DataTypes.STRING(20))
  @NotNull
  @Default('none')
  declare note: CreationOptional<string>;

  declare shipments?: NonAttribute<Shipment[]>;
  declare other_shipments?: NonAttribute<Shipment[]>;
}
