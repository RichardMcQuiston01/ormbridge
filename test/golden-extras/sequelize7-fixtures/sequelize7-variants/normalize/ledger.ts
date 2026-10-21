import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({ tableName: 'ledger', timestamps: true, underscored: true })
export class Ledger extends Model<
  InferAttributes<Ledger>,
  InferCreationAttributes<Ledger>
> {
  @Attribute(DataTypes.UUID)
  @PrimaryKey
  @Default(DataTypes.UUIDV4)
  declare id: CreationOptional<string>;

  @Attribute(DataTypes.BIGINT)
  declare hits: CreationOptional<string | null>;

  @Attribute(DataTypes.DECIMAL(12, 2))
  @NotNull
  @Default(0)
  declare balance: CreationOptional<string>;

  @Attribute(DataTypes.DOUBLE)
  declare ratio: CreationOptional<number | null>;

  @Attribute(DataTypes.DATEONLY)
  declare openedOn: CreationOptional<string | null>;

  @Attribute(DataTypes.BLOB)
  declare receipt: CreationOptional<Buffer | null>;

  @Attribute(DataTypes.JSONB)
  declare settings: CreationOptional<unknown | null>;

  @CreatedAt
  declare readonly createdAt: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updatedAt: CreationOptional<Date>;
}
