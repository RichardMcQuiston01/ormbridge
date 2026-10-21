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
  BelongsToMany,
  ColumnName,
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({
  tableName: 'product',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['title'] },
    { name: 'idx_product_slug', using: 'HASH', fields: ['slug'] },
  ],
})
export class Product extends Model<
  InferAttributes<Product>,
  InferCreationAttributes<Product>
> {
  @Attribute(DataTypes.STRING(40))
  @PrimaryKey
  declare sku: string;

  @Attribute(DataTypes.STRING(200))
  @NotNull
  declare title: string;

  @Attribute(DataTypes.STRING(100))
  @NotNull
  declare slug: string;

  @Attribute(DataTypes.DECIMAL(10, 2))
  @NotNull
  declare price: string;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  @Default(0)
  @ColumnName('in_stock')
  declare stock: CreationOptional<number>;

  @Attribute(DataTypes.DATE)
  declare deletedAt: CreationOptional<Date | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;

  @BelongsToMany(() => Product, {
    through: { model: 'product_similar', timestamps: false },
    foreignKey: 'from_product_id',
    otherKey: 'to_product_id',
    inverse: 'similarInverse',
    throughAssociations: { fromSource: 'similarLinks', toSource: 'similarSource', fromTarget: 'similarInverseLinks', toTarget: 'similarTarget' },
  })
  declare similar?: NonAttribute<Product[]>;

  declare similarInverse?: NonAttribute<Product[]>;
}
