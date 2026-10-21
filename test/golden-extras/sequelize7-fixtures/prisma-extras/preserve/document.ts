import {
  DataTypes,
  Model,
  sql,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from '@sequelize/core';
import {
  Attribute,
  ColumnName,
  CreatedAt,
  Default,
  NotNull,
  PrimaryKey,
  Table,
  Unique,
  UpdatedAt,
} from '@sequelize/core/decorators-legacy';

@Table({
  tableName: 'documents',
  schema: 'audit',
  timestamps: true,
  indexes: [
    {
      name: 'ix_document_title',
      using: 'BTREE',
      fields: [{ name: 'title', order: 'DESC' }, 'created'],
    },
    { using: 'GIN', fields: [{ name: 'meta', operator: 'JsonbPathOps' }] },
    { name: 'uq_document_title_day', unique: true, fields: ['title', 'day'] },
  ],
})
export class Document extends Model<
  InferAttributes<Document>,
  InferCreationAttributes<Document>
> {
  @Attribute(DataTypes.STRING)
  @PrimaryKey
  declare id: string;

  @Attribute(DataTypes.STRING)
  @NotNull
  @Unique('uq_document_ulid')
  declare ulid: string;

  @Attribute(DataTypes.TEXT)
  @NotNull
  declare short: string;

  @Attribute(DataTypes.UUID)
  @NotNull
  @Default(DataTypes.UUIDV4)
  declare uid: CreationOptional<string>;

  @Attribute(DataTypes.UUID)
  @NotNull
  @Default(sql.literal('gen_random_uuid()'))
  declare token: CreationOptional<string>;

  @Attribute(DataTypes.STRING)
  @NotNull
  declare title: string;

  @Attribute(DataTypes.TEXT)
  @NotNull
  declare body: string;

  @Attribute(DataTypes.ENUM('admin', 'user'))
  @NotNull
  @Default('user')
  declare role: CreationOptional<'admin' | 'user'>;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare small: number;

  @Attribute(DataTypes.DOUBLE)
  @NotNull
  declare ratio: number;

  @Attribute(DataTypes.DECIMAL(10, 2))
  @NotNull
  declare price: string;

  @Attribute(DataTypes.DECIMAL)
  @NotNull
  declare cost: string;

  @Attribute(DataTypes.BIGINT)
  @NotNull
  declare views: string;

  @Attribute(DataTypes.BLOB)
  @NotNull
  declare blob: Buffer;

  @Attribute(DataTypes.JSONB)
  @NotNull
  declare meta: unknown;

  @CreatedAt
  declare readonly created: CreationOptional<Date>;

  @UpdatedAt
  declare readonly updated: CreationOptional<Date>;

  @Attribute(DataTypes.DATEONLY)
  @NotNull
  declare day: string;

  @Attribute(DataTypes.TIME)
  @NotNull
  declare at: string;

  @Attribute(DataTypes.INET)
  @NotNull
  declare ip: string;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare internal: number;

  @Attribute(DataTypes.TEXT)
  @NotNull
  @ColumnName('legacy_name')
  declare legacy: string;
}
